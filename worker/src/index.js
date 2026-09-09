/**
 * HTTPS relay service for HTTP-only IPTV playlists.
 *
 * A user pastes an M3U URL (or Xtream Codes host + username + password) on the
 * landing page and gets back an HTTPS playlist link. Every plain-HTTP stream in
 * that playlist is rewritten to go through this worker, so players that refuse
 * HTTP (iOS apps like rPlayTV) can load the list and play the channels.
 *
 * Routes:
 *   GET /                             landing page (the form)
 *   GET /l/<cfg>/playlist.m3u         generated playlist. <cfg> is base64url JSON:
 *                                       {"u": "<m3u url>"}                    M3U source
 *                                       {"x": ["<host>", "<user>", "<pass>"]}  Xtream source
 *                                     plus optional "h": 1 to convert .ts -> .m3u8
 *                                     and, when PAYWALL is on, "k": "<access code>"
 *   GET /e/<host>/<path>?sig=<hmac>   relays http://<host>/<path>. Follows redirects,
 *                                     rewrites .m3u8 bodies, streams everything else
 *                                     through. Only hosts this worker signed are
 *                                     accepted, so it is not a general open proxy.
 *                                     With PAYWALL on the URL also carries exp=<unix>
 *                                     (covered by the signature) so streams stop when
 *                                     the customer's access lapses.
 *   POST /record                      front page reports a generated link (stored in Postgres)
 *   POST /event                       front page reports a page view or button click
 *   POST /buy                         creates a Stripe Checkout Session, 303 to Stripe
 *   GET /welcome?session_id=cs_…      after payment: verifies the session with Stripe,
 *                                     mints the access code and shows it
 *   GET /playlist.m3u, /playlist-hls.m3u
 *                                     legacy: redirect to the /l/ link for
 *                                     PLAYLIST_BASE + that name (if PLAYLIST_BASE is set)
 *
 * Paywall config (wrangler.toml [vars] unless noted):
 *   PAYWALL           "1" to require an access code on /l/ links (default off)
 *   STRIPE_SECRET_KEY secret: npx wrangler secret put STRIPE_SECRET_KEY
 *   STRIPE_PRICE_ID   the one-time Price to sell (price_…)
 *   ACCESS_DAYS       days of access one purchase buys (default 30)
 *   DATABASE_URL      secret, optional: PostgreSQL URL; link submissions and purchases
 *                     are stored there (see db/schema.sql). Absent = nothing stored.
 *   MASTER_ACCESS_KEY secret, optional: an access code for the operator that never
 *                     expires and works for any playlist (bypasses payment)
 *
 * Access codes are stateless: base64url({e: email, x: expiry, r: session id,
 * s: source hash}) plus an HMAC under PROXY_SECRET. Nothing is stored; a code is
 * valid until its expiry, and only for the one playlist source (M3U URL or Xtream
 * account) it was bought for: the buyer enters the source before checkout, its
 * hash rides along in the Checkout Session metadata, and /l/ refuses a code whose
 * hash does not match the link's source.
 */

import { recordSubmission, recordPurchase, recordEvent, requestMeta, EVENTS } from "./db.js";

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "proxy-authorization", "proxy-authenticate", "host",
]);
const PLAYLIST_TTL = 300; // seconds a generated playlist is cached
const MAX_PLAYLIST_BYTES = 32 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const self = `${url.protocol}//${url.host}`;
    if (!env.PROXY_SECRET) {
      return text("PROXY_SECRET is not set. Run: npx wrangler secret put PROXY_SECRET", 500);
    }
    if (request.method === "POST") {
      if (url.pathname === "/buy") return startCheckout(request, self, env);
      if (url.pathname === "/record") return recordLink(request, env, ctx);
      if (url.pathname === "/event") return recordPageEvent(request, env, ctx);
      return text("method not allowed", 405);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text("method not allowed", 405);
    }

    if (url.pathname === "/") return landingPage(env);
    if (url.pathname === "/welcome") return welcomePage(request, url, env, ctx);

    const gen = url.pathname.match(/^\/l\/([A-Za-z0-9_-]+)\/playlist\.m3u$/);
    if (gen) {
      let cfg;
      try { cfg = parseConfig(gen[1]); } catch (e) { return text(`bad link: ${e.message}`, 400); }
      let exp;
      if (paywallOn(env) && isMasterKey(env, cfg.token)) {
        exp = masterExp();
      } else if (paywallOn(env)) {
        const access = await verifyAccess(env, cfg.token);
        if (!access) {
          return text(`This link needs a valid access code. Get one at ${self}/ and generate the link again.`, 402);
        }
        if (access.src !== await sourceHash(cfg)) {
          return text("This access code was bought for a different playlist. Each code covers one playlist URL or Xtream account.", 402);
        }
        exp = access.exp;
      }
      const res = await cachedPlaylist(request, ctx, () => generatePlaylist(cfg, self, env, exp));
      return applyRange(request, res);
    }

    if (url.pathname.startsWith("/e/")) {
      const rest = url.pathname.slice(3);
      const slash = rest.indexOf("/");
      if (slash < 0) return text("bad edge path", 400);
      const host = rest.slice(0, slash);
      const sig = url.searchParams.get("sig") || "";
      const exp = url.searchParams.get("exp");
      url.searchParams.delete("sig");
      url.searchParams.delete("exp");
      if (!(await verify(env, host, sig, exp))) return text("bad or expired signature", 403);
      return proxyStream(request, `http://${rest}${url.search}`, self, env, exp);
    }

    if ((url.pathname === "/playlist.m3u" || url.pathname === "/playlist-hls.m3u") && env.PLAYLIST_BASE) {
      const cfg = { u: `${env.PLAYLIST_BASE}${url.pathname}` };
      return Response.redirect(`${self}${linkPath(cfg)}`, 302);
    }

    return text("not found", 404);
  },
};

// ---------------------------------------------------------------------------
// Config in the link

export function encodeConfig(cfg) {
  return b64urlEncode(JSON.stringify(cfg));
}

export function linkPath(cfg) {
  return `/l/${encodeConfig(cfg)}/playlist.m3u`;
}

export function parseConfig(b64) {
  let cfg;
  try { cfg = JSON.parse(b64urlDecode(b64)); } catch { throw new Error("config is not valid JSON"); }
  if (!cfg || typeof cfg !== "object") throw new Error("config must be an object");
  const out = { hls: cfg.h === 1 || cfg.h === true };
  if (typeof cfg.k === "string") out.token = cfg.k;
  if (typeof cfg.u === "string") {
    out.source = checkedUrl(cfg.u);
  } else if (Array.isArray(cfg.x) && cfg.x.length === 3 && cfg.x.every((s) => typeof s === "string")) {
    const [host, user, pass] = cfg.x;
    out.xtream = { origin: checkedUrl(host).origin, user, pass };
    if (!user || !pass) throw new Error("xtream username and password are required");
  } else {
    throw new Error("config needs either \"u\" (m3u url) or \"x\" (xtream [host, user, pass])");
  }
  return out;
}

/**
 * Identifies the subscription a config points at, for binding access codes:
 * 16 hex chars of SHA-256 over "x|origin|user|pass" for Xtream logins, or
 * "u|url" for other M3U URLs. A get.php URL carrying username and password is
 * the same subscription as the Xtream login with those credentials, so it
 * hashes the same way. The HLS option does not affect it.
 */
export async function sourceHash(cfg) {
  let id;
  const xt = cfg.xtream || (cfg.source && xtreamFromM3uUrl(cfg.source));
  if (xt) id = `x|${xt.origin.toLowerCase()}|${xt.user}|${xt.pass}`;
  else id = `u|${cfg.source.href}`;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function checkedUrl(s) {
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`); } catch { throw new Error(`not a URL: ${s}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported scheme: ${u.protocol}`);
  if (!u.hostname || isPrivateHost(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`);
  return u;
}

function isPrivateHost(h) {
  h = h.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(":")) return h === "::1" || h === "::" || /^(fc|fd|fe[89ab])/i.test(h);
  return false;
}

// ---------------------------------------------------------------------------
// Playlist generation

async function cachedPlaylist(request, ctx, produce) {
  const cache = caches.default;
  const key = new Request(request.url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await produce();
  if (res.ok) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/**
 * Honour a single `Range: bytes=a-b` on a complete 200 response, the way a
 * static file host does. Some players probe a URL with a Range request before
 * deciding what it is; answering like raw.githubusercontent.com keeps them happy.
 */
async function applyRange(request, res) {
  const range = request.headers.get("range");
  if (!range || res.status !== 200) return res;
  const m = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return res;
  const buf = new Uint8Array(await res.arrayBuffer());
  const size = buf.byteLength;
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  const headers = new Headers(res.headers);
  headers.set("accept-ranges", "bytes");
  if (start >= size || start > end) {
    headers.set("content-range", `bytes */${size}`);
    headers.delete("content-length");
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(request.method === "HEAD" ? null : buf.subarray(start, end + 1), { status: 206, headers });
}

async function generatePlaylist(cfg, self, env, exp) {
  let source;
  try {
    source = cfg.xtream ? await buildXtreamPlaylist(cfg.xtream, cfg.hls) : await loadM3uSource(cfg);
  } catch (e) {
    return text(`could not load source playlist: ${e.message}`, 502);
  }
  const body = await rewritePlaylist(source, self, env, { hls: cfg.hls, exp });
  // Served as text/plain, like raw.githubusercontent.com does. Some players
  // (CarTv) take an mpegurl content-type to mean "this is a media stream" and
  // refuse the URL as a channel list.
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "accept-ranges": "bytes",
      "cache-control": `public, max-age=${PLAYLIST_TTL}`,
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * Load an M3U from its URL. Many Xtream Codes panels refuse get.php (this
 * provider answers HTTP 884 with an empty body) while player_api.php works, so
 * if the URL is a get.php link carrying username and password and the fetch
 * fails or does not return an M3U, build the playlist from the API instead.
 */
async function loadM3uSource(cfg) {
  let m3uError;
  try {
    const source = await fetchSourcePlaylist(cfg.source);
    if (source.trimStart().startsWith("#EXTM3U")) return source;
    m3uError = new Error("source does not look like an M3U playlist (no #EXTM3U header)");
  } catch (e) {
    m3uError = e;
  }
  const xt = xtreamFromM3uUrl(cfg.source);
  if (!xt) throw m3uError;
  try {
    return await buildXtreamPlaylist(xt, cfg.hls);
  } catch (e) {
    throw new Error(`${m3uError.message}; also tried the Xtream API: ${e.message}`);
  }
}

/** get.php?username=..&password=.. -> Xtream credentials, or null if the URL is not one. */
export function xtreamFromM3uUrl(url) {
  if (!/\/get\.php$/i.test(url.pathname)) return null;
  const user = url.searchParams.get("username");
  const pass = url.searchParams.get("password");
  if (!user || !pass) return null;
  return { origin: url.origin, user, pass };
}

async function fetchSourcePlaylist(url) {
  const res = await fetch(url.toString(), {
    headers: { "user-agent": "VLC/3.0.20 LibVLC/3.0.20" },
    redirect: "follow",
    cf: { cacheTtl: PLAYLIST_TTL },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.host}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_PLAYLIST_BYTES) throw new Error("playlist too large");
  return res.text();
}

/** Port of build_playlist.py: build an M3U from the Xtream Codes player_api. */
async function buildXtreamPlaylist({ origin, user, pass }, hls) {
  const api = (action) =>
    fetch(`${origin}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=${action}`, {
      headers: { "user-agent": "VLC/3.0.20 LibVLC/3.0.20" },
      cf: { cacheTtl: PLAYLIST_TTL },
    }).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} from player_api.php (${action})`);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error(`player_api.php ${action} did not return a list (bad credentials?)`);
      return j;
    });
  const [catList, streams] = await Promise.all([api("get_live_categories"), api("get_live_streams")]);
  const cats = new Map(catList.map((c) => [String(c.category_id), c.category_name]));
  streams.sort((a, b) => (a.num || 0) - (b.num || 0));
  const ext = hls ? "m3u8" : "ts";
  const lines = ['#EXTM3U x-tvg-url=""'];
  for (const s of streams) {
    const name = clean(s.name);
    const group = clean(cats.get(String(s.category_id)) ?? "Uncategorized");
    lines.push(
      `#EXTINF:-1 tvg-id="${clean(s.epg_channel_id)}" tvg-name="${name}" tvg-logo="${clean(s.stream_icon)}" group-title="${group}",${name}`,
      `${origin}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${s.stream_id}.${ext}`,
    );
  }
  return lines.join("\n") + "\n";
}

function clean(s) {
  return String(s ?? "").replace(/"/g, "'").replace(/\n/g, " ").trim();
}

/**
 * Rewrite every plain-HTTP stream URL in an M3U to go through /e/. HTTPS URLs
 * are left alone. With hls=true, Xtream-style `.ts` stream URLs become `.m3u8`.
 *
 * Playlists can have tens of thousands of lines and Workers get ~10ms of CPU
 * per request on the free tier, so this signs each distinct host once up front
 * and then does a single synchronous regex pass over the whole text.
 */
export async function rewritePlaylist(textBody, self, env, { hls = false, exp } = {}) {
  const selfHost = new URL(self).host.toLowerCase();
  const sigs = new Map();
  for (const [, host] of textBody.matchAll(STREAM_LINE_RE)) {
    const h = host.toLowerCase();
    if (!sigs.has(h) && h !== selfHost && !isPrivateHost(hostnameOf(h))) sigs.set(h, null);
  }
  const signer = hostSigner(env, exp);
  await Promise.all([...sigs.keys()].map(async (h) => sigs.set(h, await signer(h))));

  const prefix = `${self}/e/`;
  return textBody.replace(STREAM_LINE_RE, (line, host, rest) => {
    const sig = sigs.get(host.toLowerCase());
    if (!sig) return line;
    const q = rest.indexOf("?");
    if (hls) {
      const path = q < 0 ? rest : rest.slice(0, q);
      if (path.endsWith(".ts")) rest = `${path.slice(0, -3)}.m3u8${q < 0 ? "" : rest.slice(q)}`;
    }
    if (!rest.startsWith("/")) rest = `/${rest}`;
    return `${prefix}${host}${rest}${q < 0 ? "?" : "&"}${sig}`;
  });
}

// A non-comment M3U line holding a plain-http URL: captures host[:port] and the rest.
const STREAM_LINE_RE = /^http:\/\/([^\/?#\s]+)(\S*)$/gim;

/** "host:port" / "[v6]:port" -> hostname as new URL() would report it. */
function hostnameOf(host) {
  const m = host.match(/^(\[[^\]]*\]|[^:]+)(?::\d*)?$/);
  return m ? m[1] : host;
}

// ---------------------------------------------------------------------------
// Stream relay

async function proxyStream(request, upstream, self, env, exp) {
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!HOP_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }
  if (!headers.has("user-agent")) headers.set("user-agent", "VLC/3.0.20 LibVLC/3.0.20");

  let res;
  try {
    res = await fetch(upstream, { method: request.method, headers, redirect: "follow" });
  } catch (e) {
    return text(`upstream fetch failed: ${e.message}`, 502);
  }

  const out = new Headers();
  for (const [k, v] of res.headers) {
    if (!HOP_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  out.set("access-control-allow-origin", "*");

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const finalUrl = new URL(res.url || upstream);
  const isHls = ct.includes("mpegurl") || finalUrl.pathname.endsWith(".m3u8");

  if (isHls) {
    const body = await rewriteHls(await res.text(), finalUrl, self, hostSigner(env, exp));
    out.delete("content-length");
    out.set("content-type", "application/vnd.apple.mpegurl");
    out.set("cache-control", "no-cache");
    return new Response(body, { status: res.status, headers: out });
  }

  // Binary (MPEG-TS, segments, keys): pass the body through untouched.
  return new Response(res.body, { status: res.status, headers: out });
}

/** Rewrite segment/key/map URIs inside an HLS manifest to go through /e/. */
export async function rewriteHls(textBody, base, self, signer) {
  const out = [];
  for (const line of textBody.split("\n")) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }
    if (t.startsWith("#")) {
      // URI="..." attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF).
      let s = t;
      for (const [, u] of t.matchAll(/URI="([^"]+)"/g)) {
        s = s.replace(`URI="${u}"`, `URI="${await toProxy(u, base, self, signer)}"`);
      }
      out.push(s);
      continue;
    }
    out.push(await toProxy(t, base, self, signer));
  }
  return out.join("\n");
}

/** Turn a (possibly relative) http URL into a signed /e/ URL. Anything else is returned as-is. */
async function toProxy(ref, base, self, signer) {
  let abs;
  try { abs = base ? new URL(ref, base) : new URL(ref); } catch { return ref; }
  if (abs.protocol !== "http:") return base ? abs.href : ref; // https etc.: leave alone
  if (abs.host === new URL(self).host || isPrivateHost(abs.hostname)) return abs.href;
  const sep = abs.search ? "&" : "?";
  return `${self}/e/${abs.host}${abs.pathname}${abs.search}${sep}${await signer(abs.host)}`;
}

// ---------------------------------------------------------------------------
// Signing. The signature covers the upstream host (not the full URL): a
// playlist with 16k channels would otherwise need 16k HMACs per request, and
// per-URL signing buys nothing extra here because anyone holding the playlist
// can already reach every path on that host through the provider directly.
// With the paywall on it also covers the customer's access expiry, carried in
// the URL as exp=<unix seconds>, so relayed streams stop when access lapses.

let keyCache = null;
async function hmacKey(env) {
  if (keyCache && keyCache.secret === env.PROXY_SECRET) return keyCache.key;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.PROXY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  keyCache = { secret: env.PROXY_SECRET, key };
  return key;
}

/** Truncated (128-bit) hex HMAC-SHA256 of `msg` under PROXY_SECRET. */
async function hmacHex(env, msg) {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(msg));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sign(env, host, exp) {
  const h = host.toLowerCase();
  return hmacHex(env, exp ? `${h}|${exp}` : h);
}

/**
 * Returns a memoised per-host signer that yields the query-string tail for
 * /e/ URLs: "sig=…", or "exp=…&sig=…" when an access expiry is in force.
 */
function hostSigner(env, exp) {
  const memo = new Map();
  const lead = exp ? `exp=${exp}&` : "";
  return async (host) => {
    let s = memo.get(host);
    if (!s) { s = `${lead}sig=${await sign(env, host, exp)}`; memo.set(host, s); }
    return s;
  };
}

async function verify(env, host, sig, exp, now = Date.now() / 1000) {
  if (exp != null) {
    if (!/^\d{1,12}$/.test(exp) || Number(exp) <= now) return false;
  } else if (paywallOn(env)) {
    return false; // links generated before the paywall was switched on
  }
  return macEqual(await sign(env, host, exp || undefined), sig);
}

function macEqual(expected, given) {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Access codes (the paywall)

function paywallOn(env) {
  return env.PAYWALL === "1" || env.PAYWALL === "true";
}

/** The operator's master code: constant-time compare against MASTER_ACCESS_KEY (if set). */
function isMasterKey(env, code) {
  const master = env.MASTER_ACCESS_KEY;
  if (typeof master !== "string" || master.length < 8 || typeof code !== "string") return false;
  return macEqual(master, code);
}

/** Stream-URL expiry for master-key playlists: a year out, rounded to the day so the cache stays useful. */
function masterExp() {
  return Math.floor(Date.now() / 86400000) * 86400 + 366 * 86400;
}

function accessDays(env) {
  const d = Number(env.ACCESS_DAYS);
  return Number.isFinite(d) && d > 0 ? d : 30;
}

/** Make an access code: base64url payload + "." + HMAC. Deterministic for the same input. */
export async function mintAccess(env, { email = "", exp, ref = "", src }) {
  if (!/^[0-9a-f]{16}$/.test(src || "")) throw new Error("mintAccess: src (sourceHash) is required");
  const payload = b64urlEncode(JSON.stringify({ e: email, x: exp, r: ref, s: src }));
  return `${payload}.${await hmacHex(env, `access|${payload}`)}`;
}

/** Check an access code. Returns {email, exp, ref, src} or null if invalid/expired/unbound. */
export async function verifyAccess(env, code, now = Date.now() / 1000) {
  if (typeof code !== "string" || code.length > 512) return null;
  const dot = code.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = code.slice(0, dot);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  if (!macEqual(await hmacHex(env, `access|${payload}`), code.slice(dot + 1))) return null;
  let a;
  try { a = JSON.parse(b64urlDecode(payload)); } catch { return null; }
  if (!a || typeof a.x !== "number" || !(a.x > now)) return null;
  if (typeof a.s !== "string" || !/^[0-9a-f]{16}$/.test(a.s)) return null; // codes are always bound to a source
  return { email: String(a.e ?? ""), exp: a.x, ref: String(a.r ?? ""), src: a.s };
}

// ---------------------------------------------------------------------------
// Stripe. One-time payment via Checkout; the success page verifies the session
// server-side and mints the access code, so no webhook or database is needed.

async function stripe(env, method, path, form) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set (npx wrangler secret put STRIPE_SECRET_KEY)");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Stripe HTTP ${res.status}`);
  return j;
}

async function startCheckout(request, self, env) {
  if (!paywallOn(env)) return text("the paywall is off; access codes are not needed", 404);
  if (!env.STRIPE_PRICE_ID) return text("STRIPE_PRICE_ID is not set", 500);
  // The playlist source comes along as form field "cfg" (same base64url JSON as
  // in /l/ links, without "k"). Only its hash is sent to Stripe.
  let cfg;
  try {
    const form = await request.formData();
    const raw = String(form.get("cfg") || "");
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("missing playlist details");
    cfg = parseConfig(raw);
  } catch (e) {
    return text(`cannot start checkout: ${e.message}`, 400);
  }
  let session;
  try {
    session = await stripe(env, "POST", "/checkout/sessions", {
      mode: "payment",
      "line_items[0][price]": env.STRIPE_PRICE_ID,
      "line_items[0][quantity]": "1",
      "metadata[src]": await sourceHash(cfg),
      success_url: `${self}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${self}/`,
      allow_promotion_codes: "true",
    });
  } catch (e) {
    return text(`could not start checkout: ${e.message}`, 502);
  }
  return Response.redirect(session.url, 303);
}

/**
 * The front page calls this after it has generated a link and checked it,
 * so each generated link is stored once (players re-fetching the playlist
 * every few minutes are not). Body: JSON {cfg, status, lang}. Always 204.
 */
async function recordLink(request, env, ctx) {
  let body;
  try { body = JSON.parse(await request.text()); } catch { return text("bad json", 400); }
  if (!body || typeof body.cfg !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.cfg)) return text("missing cfg", 400);
  let cfg;
  try { cfg = parseConfig(body.cfg); } catch (e) { return text(`bad cfg: ${e.message}`, 400); }
  cfg.sourceHash = await sourceHash(cfg);
  const master = paywallOn(env) && isMasterKey(env, cfg.token);
  const access = master || !cfg.token ? null : await verifyAccess(env, cfg.token);
  await recordSubmission(env, ctx, { cfg, access, master, status: body.status, lang: body.lang, meta: requestMeta(request) });
  return new Response(null, { status: 204 });
}

/** Body: JSON {event, visitor, lang, page, referrer}. Always 204 for a known event. */
async function recordPageEvent(request, env, ctx) {
  let body;
  try { body = JSON.parse(await request.text()); } catch { return text("bad json", 400); }
  if (!body || !EVENTS.has(body.event)) return text("unknown event", 400);
  await recordEvent(env, ctx, { ...body, meta: requestMeta(request) });
  return new Response(null, { status: 204 });
}

async function welcomePage(request, url, env, ctx) {
  if (!paywallOn(env)) return text("the paywall is off; access codes are not needed", 404);
  const id = url.searchParams.get("session_id") || "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return text("missing or malformed session_id", 400);
  let s;
  try { s = await stripe(env, "GET", `/checkout/sessions/${id}`); } catch (e) {
    return text(`could not verify the payment: ${e.message}`, 502);
  }
  if (s.payment_status !== "paid") {
    return text("Payment not completed yet. If you just paid, refresh this page in a moment.", 402);
  }
  const src = s.metadata?.src;
  if (!/^[0-9a-f]{16}$/.test(src || "")) {
    return text("This payment is not linked to a playlist. Please contact support with your receipt.", 500);
  }
  // Expiry counts from when the session was created, so revisiting this page yields the same code.
  const exp = Math.floor(Number(s.created) + accessDays(env) * 86400);
  const email = s.customer_details?.email || "";
  const code = await mintAccess(env, { email, exp, ref: s.id, src });
  recordPurchase(env, ctx, { session: s, src, exp, meta: requestMeta(request) });
  const until = new Date(exp * 1000).toISOString().slice(0, 10);
  const html = WELCOME_HTML
    .replace(/__CODE__/g, escapeHtml(code))
    .replace(/__UNTIL__/g, until)
    .replace(/__EMAIL__/g, escapeHtml(email));
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Helpers

function text(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function b64urlEncode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// ---------------------------------------------------------------------------
// Pages. Written for people who bought an IPTV subscription and got an error in
// their player app; no protocol talk on the page.

function landingPage(env) {
  const price = typeof env.PRICE_LABEL === "string" ? env.PRICE_LABEL.trim() : "";
  const html = LANDING_HTML
    .replace(/__PAYWALL__/g, paywallOn(env) ? "1" : "0")
    .replace(/__DAYS__/g, String(accessDays(env)))
    .replace(/__PRICE_EN__/g, price ? ` for ${escapeHtml(price)}` : "")
    .replace(/__PRICE_AR__/g, price ? ` مقابل ${escapeHtml(price)}` : "");
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

const PAGE_HEAD = `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Nunito+Sans:ital,wght@0,400;0,600;0,700;1,400&family=Cairo:wght@400;600;700&display=swap">
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f6fa; --surface: #ffffff; --ink: #12192b; --muted: #5b6478; --line: #dde2ec; --field: #f7f9fc;
    --accent: #0f8b8d; --accent-ink: #ffffff; --accent-soft: #e3f3f3;
    --ok: #1b7f4b; --ok-soft: #e4f4ea; --err: #c0392b; --err-soft: #fbe9e7;
    --shadow: 0 10px 30px rgba(18, 25, 43, .08);
    --font-display: Sora, "Nunito Sans", sans-serif;
    --font-body: "Nunito Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  html[lang="ar"] { --font-display: Cairo, "Segoe UI", Tahoma, sans-serif; --font-body: Cairo, "Segoe UI", Tahoma, sans-serif; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0e1420; --surface: #161e2e; --ink: #eef1f7; --muted: #9aa5ba; --line: #283246; --field: #111826;
      --accent: #2fb8ba; --accent-ink: #061417; --accent-soft: #123639;
      --ok: #4ccb84; --ok-soft: #12321f; --err: #ff7b6b; --err-soft: #3a1c19;
      --shadow: 0 10px 30px rgba(0, 0, 0, .35);
    }
  }
  :root[data-theme="dark"] {
    --bg: #0e1420; --surface: #161e2e; --ink: #eef1f7; --muted: #9aa5ba; --line: #283246; --field: #111826;
    --accent: #2fb8ba; --accent-ink: #061417; --accent-soft: #123639;
    --ok: #4ccb84; --ok-soft: #12321f; --err: #ff7b6b; --err-soft: #3a1c19;
    --shadow: 0 10px 30px rgba(0, 0, 0, .35);
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.6 var(--font-body); }
  main { max-width: 680px; margin: 0 auto; padding: 48px 20px 72px; display: grid; gap: 40px; }
  h1, h2, h3 { font-family: var(--font-display); letter-spacing: -.01em; text-wrap: balance; margin: 0; }
  h1 { font-size: clamp(1.9rem, 5vw, 2.6rem); line-height: 1.12; font-weight: 700; }
  h2 { font-size: 1.25rem; font-weight: 600; }
  h3 { font-size: 1rem; font-weight: 600; }
  p { margin: 0; }
  .lead { color: var(--muted); font-size: 1.1rem; max-width: 34em; }
  .hero { display: grid; gap: 14px; }
  .hero-photo { margin: 0; display: grid; gap: 8px; }
  .hero-photo img { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 18px; box-shadow: var(--shadow); background: #0b1728; }
  .hero-photo figcaption { color: var(--muted); font-size: .9rem; }
  html[lang="ar"] h1, html[lang="ar"] h2, html[lang="ar"] h3 { letter-spacing: 0; }
  html[lang="ar"] h1 { line-height: 1.3; }
  .lang { display: flex; justify-content: flex-end; gap: 4px; margin-bottom: -20px; }
  .lang button { border: 1px solid var(--line); background: var(--surface); color: var(--muted); border-radius: 999px; padding: 6px 14px; font: inherit; font-size: .9rem; font-weight: 700; cursor: pointer; }
  .lang button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  input[dir="ltr"] { text-align: left; }
  .applink { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--ink); text-decoration: none; font-weight: 700; font-size: .95rem; }
  .applink::before { content: ""; width: 18px; height: 18px; border-radius: 5px; background: var(--accent); flex: none; }
  .applink:hover { border-color: var(--accent); color: var(--accent); }
  .eyebrow { font-size: .8rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }

  /* before / after */
  .proof { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 560px) { .proof { grid-template-columns: 1fr; } }
  .proof figure { margin: 0; display: grid; gap: 10px; }
  .proof figcaption { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: .95rem; }
  .tag { font-size: .72rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; }
  .tag.before { background: var(--err-soft); color: var(--err); }
  .tag.after { background: var(--ok-soft); color: var(--ok); }
  .proof img { display: block; width: 100%; height: auto; aspect-ratio: 9 / 16; object-fit: contain; border-radius: 18px; border: 1px solid var(--line); background: #0b1728; box-shadow: var(--shadow); }

  /* the form */
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 24px; box-shadow: var(--shadow); display: grid; gap: 18px; }
  .card h2 { margin-bottom: -6px; }
  .tabs { display: flex; gap: 6px; padding: 4px; background: var(--field); border: 1px solid var(--line); border-radius: 12px; }
  .tabs button { flex: 1; padding: 10px; border: 0; background: transparent; color: var(--muted); border-radius: 9px; cursor: pointer; font: inherit; font-weight: 600; }
  .tabs button[aria-selected="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .field { display: grid; gap: 6px; }
  label { font-weight: 700; font-size: .95rem; }
  .help { color: var(--muted); font-size: .9rem; }
  input[type=text], input[type=url], input[type=password] { width: 100%; padding: 13px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--field); color: var(--ink); font: inherit; }
  input:focus-visible, button:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .check { display: flex; gap: 12px; align-items: flex-start; }
  .check input { width: 20px; height: 20px; margin: 3px 0 0; accent-color: var(--accent); flex: none; }
  .check .help { display: block; }
  .access { display: grid; gap: 6px; padding: 16px; border-radius: 14px; background: var(--accent-soft); }
  .access .help { color: var(--ink); opacity: .85; }
  .linkish { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; font: inherit; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
  .primary { width: 100%; padding: 15px; border: 0; border-radius: 12px; background: var(--accent); color: var(--accent-ink); font: inherit; font-size: 1.05rem; font-weight: 700; cursor: pointer; }
  a.primary { display: block; text-align: center; text-decoration: none; }
  .result { display: grid; gap: 10px; padding-top: 18px; border-top: 1px solid var(--line); }
  .link { display: flex; gap: 8px; }
  .link input { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  .link button { padding: 0 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: var(--ink); cursor: pointer; font: inherit; font-weight: 700; }
  .status { font-size: .95rem; min-height: 1.4em; }
  .status.ok { color: var(--ok); } .status.err { color: var(--err); }
  .status small { display: block; color: var(--muted); font-size: .82rem; margin-top: 4px; }

  /* steps + faq */
  .steps { display: grid; gap: 14px; counter-reset: step; }
  .steps li { list-style: none; display: grid; grid-template-columns: 36px 1fr; gap: 14px; align-items: start; }
  .steps li::before { counter-increment: step; content: counter(step); font-variant-numeric: tabular-nums; width: 36px; height: 36px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-family: Sora, sans-serif; font-weight: 700; display: grid; place-items: center; }
  .steps ol, .steps ul { margin: 0; padding: 0; display: grid; gap: 14px; }
  .steps p { color: var(--muted); font-size: .95rem; }
  .faq { display: grid; gap: 4px; }
  .faq details { border-top: 1px solid var(--line); padding: 12px 0; }
  .faq details:last-child { border-bottom: 1px solid var(--line); }
  .faq summary { cursor: pointer; font-weight: 700; list-style: none; display: flex; justify-content: space-between; gap: 12px; }
  .faq summary::-webkit-details-marker { display: none; }
  .faq summary::after { content: "+"; color: var(--accent); font-family: Sora, sans-serif; }
  .faq details[open] summary::after { content: "–"; }
  .faq details p { color: var(--muted); padding-top: 8px; font-size: .97rem; }
  footer { color: var(--muted); font-size: .9rem; }
  @media (prefers-reduced-motion: no-preference) { .tabs button, .primary, .link button { transition: background-color .15s ease, color .15s ease; } }
</style>`;

const LANDING_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<title>إصلاح رابط القنوات</title>
${PAGE_HEAD}
</head>
<body data-title-key="title">
<main>
  <nav class="lang" aria-label="Language">
    <button type="button" data-lang="ar" aria-pressed="true">العربية</button>
    <button type="button" data-lang="en" aria-pressed="false">English</button>
  </nav>
  <section class="hero">
    <p class="eyebrow" data-i18n="eyebrow">لتطبيق rPlay TV على الآيفون وCarPlay</p>
    <h1 data-i18n="h1">شاهد اشتراك IPTV المدفوع في سيارتك.</h1>
    <p class="lead" data-i18n="lead">لديك اشتراك IPTV مدفوع لكنه يرفض العمل في تطبيق rPlay TV؟ الصق رابط مزوّدك هنا واحصل على رابط جديد يقبله التطبيق، وتعمل قنواتك على شاشة السيارة عبر CarPlay وعلى الآيفون.</p>
    <p><a class="applink" href="https://apps.apple.com/app/id6795052913" target="_blank" rel="noopener" data-i18n="appLink">احصل على تطبيق rPlay TV من App Store</a></p>
  </section>

  <figure class="hero-photo">
    <img src="/hero.jpg" width="1600" height="900" alt="" loading="eager" fetchpriority="high">
    <figcaption data-i18n="heroCaption">مباراة مباشرة من اشتراك مدفوع، تعمل عبر رابط مُعدَّل في تطبيق rPlay TV على شاشة السيارة.</figcaption>
  </figure>

  <section class="proof">
    <figure>
      <figcaption><span class="tag before" data-i18n="before">قبل</span> <span data-i18n="beforeCap">رابط مزوّدك</span></figcaption>
      <img src="/before.jpg" width="864" height="1600" alt="Endpoint not found (404)" loading="eager">
    </figure>
    <figure>
      <figcaption><span class="tag after" data-i18n="after">بعد</span> <span data-i18n="afterCap">رابطك الجديد</span></figcaption>
      <img src="/after.jpg" width="1011" height="1600" alt="Connected successfully, 1642 channels found" loading="eager">
    </figure>
  </section>

  <form class="card" id="f" novalidate>
    <h2 data-i18n="formTitle">احصل على رابطك الجديد</h2>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-tab="m3u" data-i18n="tabLink">لديّ رابط</button>
      <button type="button" role="tab" aria-selected="false" data-tab="xtream" data-i18n="tabLogin">لديّ اسم مستخدم وكلمة مرور</button>
    </div>

    <section data-panel="m3u" class="field">
      <label for="m3u" data-i18n="m3uLabel">رابط قائمتك</label>
      <input type="text" id="m3u" dir="ltr" placeholder="http://…/get.php?username=…&amp;password=…" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url">
      <p class="help" data-i18n="m3uHelp">الرابط الذي أرسله لك مزوّدك. عادةً يحتوي على «get.php».</p>
    </section>

    <section data-panel="xtream" hidden>
      <div class="field" style="display:grid;gap:14px">
        <div class="field">
          <label for="host" data-i18n="hostLabel">عنوان الخادم</label>
          <input type="text" id="host" dir="ltr" placeholder="http://provider.example:8080" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url">
        </div>
        <div class="field">
          <label for="user" data-i18n="userLabel">اسم المستخدم</label>
          <input type="text" id="user" dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
        <div class="field">
          <label for="pass" data-i18n="passLabel">كلمة المرور</label>
          <input type="password" id="pass" dir="ltr" autocomplete="off">
        </div>
        <p class="help" data-i18n="loginHelp">قد يسمّيها مزوّدك بيانات «Xtream».</p>
      </div>
    </section>

    <label class="check"><input type="checkbox" id="hls" checked>
      <span><span data-i18n="hlsLabel">تحسين للآيفون والآيباد</span><span class="help" data-i18n="hlsHelp">مُوصى به. أوقفه فقط إذا رفضت القنوات العمل.</span></span>
    </label>

    <section class="access" id="access" hidden>
      <label for="key" data-i18n="keyLabel">رمز الوصول</label>
      <input type="text" id="key" dir="ltr" data-i18n-ph="keyPh" placeholder="الصق رمز الوصول" autocomplete="off" autocapitalize="off" spellcheck="false">
      <p class="help"><span data-i18n="hint1">ليس لديك رمز بعد؟ أدخل بياناتك أعلاه ثم </span><button type="button" class="linkish" id="buy" data-i18n="buy">احصل على وصول لمدة __DAYS__ يومًا__PRICE_AR__</button><span data-i18n="hint2">. رمز واحد يغطي اشتراكًا واحدًا على كل أجهزتك.</span></p>
    </section>

    <button class="primary" type="submit" data-i18n="submit">احصل على رابطي الجديد</button>

    <div class="result" id="result" hidden>
      <label for="out" data-i18n="outLabel">رابطك الجديد</label>
      <div class="link">
        <input type="text" id="out" dir="ltr" readonly>
        <button type="button" id="copy" data-i18n="copy">نسخ</button>
      </div>
      <div class="status" id="status"></div>
    </div>
  </form>

  <section class="steps">
    <h2 data-i18n="stepsTitle">كيف يعمل</h2>
    <ol>
      <li><div><h3 data-i18n="s1">الصق رابط مزوّدك أو بيانات دخولك</h3><p data-i18n="s1t">نحتفظ ببياناتك بأمان لنساعدك إذا حدث خطأ. لا نشاركها ولا نبيعها أبدًا.</p></div></li>
      <li><div><h3 data-i18n="s2">احصل على رابطك الجديد</h3><p data-i18n="s2t">يحتوي على نفس قنوات اشتراكك، بالصيغة التي تتوقعها مشغّلات الآيفون.</p></div></li>
      <li><div><h3 data-i18n="s3">أضفه إلى rPlay TV</h3><p data-i18n="s3t">الصقه حيث يطلب التطبيق رابط قائمة أو M3U، وشاهد على الآيفون أو في السيارة عبر CarPlay.</p></div></li>
    </ol>
  </section>

  <section class="faq">
    <h2 style="margin-bottom:10px" data-i18n="faqTitle">أسئلة شائعة</h2>
    <details><summary data-i18n="q2">هل يعمل مع تطبيق المشغّل الخاص بي؟</summary><p data-i18n="a2">صُمم لتطبيق rPlay TV على الآيفون والآيباد وCarPlay، ويعمل مع أي مشغّل يقبل رابط قائمة. إذا رفضت قناة العمل، عُد هنا وأوقف «تحسين للآيفون والآيباد» وأنشئ رابطًا جديدًا.</p></details>
    <details><summary data-i18n="q3">لماذا فشل رابط مزوّدي من الأساس؟</summary><p data-i18n="a3">كثير من المزوّدين يرسلون روابط تحجبها تطبيقات الآيفون لأسباب أمنية. رابطك الجديد يُقدَّم بطريقة تقبلها هذه التطبيقات، بنفس القنوات.</p></details>
    <details><summary data-i18n="q4">هل يمكنني المشاهدة على عدة أجهزة؟</summary><p data-i18n="a4">نعم. استخدم نفس الرابط عليها كلها. أما عدد الأجهزة التي تعمل في نفس الوقت فيحدده مزوّدك، لا نحن.</p></details>
    <details><summary data-i18n="q5">شيء لا يعمل</summary><p data-i18n="a5">تأكد أولًا أن اشتراكك ما زال فعّالًا لدى مزوّدك. إن كان كذلك واستمر الفشل، أنشئ رابطًا جديدًا هنا؛ غالبًا تُحل المشكلة.</p></details>
  </section>

  <footer><p data-i18n="footer">هذه الخدمة تمرّر قنواتك كما هي. لا علاقة لها بأي مزوّد أو تطبيق مشغّل.</p></footer>
</main>
<script>
(function () {
  var I18N = {"ar": {"title": "إصلاح رابط القنوات", "eyebrow": "لتطبيق rPlay TV على الآيفون وCarPlay", "h1": "شاهد اشتراك IPTV المدفوع في سيارتك.", "lead": "لديك اشتراك IPTV مدفوع لكنه يرفض العمل في تطبيق rPlay TV؟ الصق رابط مزوّدك هنا واحصل على رابط جديد يقبله التطبيق، وتعمل قنواتك على شاشة السيارة عبر CarPlay وعلى الآيفون.", "heroCaption": "مباراة مباشرة من اشتراك مدفوع، تعمل عبر رابط مُعدَّل في تطبيق rPlay TV على شاشة السيارة.", "before": "قبل", "beforeCap": "رابط مزوّدك", "after": "بعد", "afterCap": "رابطك الجديد", "formTitle": "احصل على رابطك الجديد", "tabLink": "لديّ رابط", "tabLogin": "لديّ اسم مستخدم وكلمة مرور", "m3uLabel": "رابط قائمتك", "m3uHelp": "الرابط الذي أرسله لك مزوّدك. عادةً يحتوي على «get.php».", "hostLabel": "عنوان الخادم", "userLabel": "اسم المستخدم", "passLabel": "كلمة المرور", "loginHelp": "قد يسمّيها مزوّدك بيانات «Xtream».", "hlsLabel": "تحسين للآيفون والآيباد", "hlsHelp": "مُوصى به. أوقفه فقط إذا رفضت القنوات العمل.", "keyLabel": "رمز الوصول", "keyPh": "الصق رمز الوصول", "hint1": "ليس لديك رمز بعد؟ أدخل بياناتك أعلاه ثم ", "buy": "احصل على وصول لمدة __DAYS__ يومًا__PRICE_AR__", "hint2": ". رمز واحد يغطي اشتراكًا واحدًا على كل أجهزتك.", "submit": "احصل على رابطي الجديد", "outLabel": "رابطك الجديد", "copy": "نسخ", "stepsTitle": "كيف يعمل", "s1": "الصق رابط مزوّدك أو بيانات دخولك", "s1t": "نحتفظ ببياناتك بأمان لنساعدك إذا حدث خطأ. لا نشاركها ولا نبيعها أبدًا.", "s2": "احصل على رابطك الجديد", "s2t": "يحتوي على نفس قنوات اشتراكك، بالصيغة التي تتوقعها مشغّلات الآيفون.", "s3": "أضفه إلى rPlay TV", "s3t": "الصقه حيث يطلب التطبيق رابط قائمة أو M3U، وشاهد على الآيفون أو في السيارة عبر CarPlay.", "faqTitle": "أسئلة شائعة", "q2": "هل يعمل مع تطبيق المشغّل الخاص بي؟", "a2": "صُمم لتطبيق rPlay TV على الآيفون والآيباد وCarPlay، ويعمل مع أي مشغّل يقبل رابط قائمة. إذا رفضت قناة العمل، عُد هنا وأوقف «تحسين للآيفون والآيباد» وأنشئ رابطًا جديدًا.", "q3": "لماذا فشل رابط مزوّدي من الأساس؟", "a3": "كثير من المزوّدين يرسلون روابط تحجبها تطبيقات الآيفون لأسباب أمنية. رابطك الجديد يُقدَّم بطريقة تقبلها هذه التطبيقات، بنفس القنوات.", "q4": "هل يمكنني المشاهدة على عدة أجهزة؟", "a4": "نعم. استخدم نفس الرابط عليها كلها. أما عدد الأجهزة التي تعمل في نفس الوقت فيحدده مزوّدك، لا نحن.", "q5": "شيء لا يعمل", "a5": "تأكد أولًا أن اشتراكك ما زال فعّالًا لدى مزوّدك. إن كان كذلك واستمر الفشل، أنشئ رابطًا جديدًا هنا؛ غالبًا تُحل المشكلة.", "footer": "هذه الخدمة تمرّر قنواتك كما هي. لا علاقة لها بأي مزوّد أو تطبيق مشغّل.", "errNoLink": "الصق رابط القائمة من مزوّدك أولًا.", "errNoLogin": "أدخل عنوان الخادم واسم المستخدم وكلمة المرور.", "errNoCode": "أدخل رمز الوصول، أو احصل على واحد أولًا.", "checking": "نتحقق من قنواتك…", "ok": "قنواتك تعمل. انسخ الرابط والصقه في مشغّلك.", "ready": "رابطك جاهز. انسخه والصقه في مشغّلك.", "copied": "تم النسخ. الآن الصقه في مشغّلك.", "err402": "رمز الوصول هذا غير صالح لهذا الاشتراك، أو انتهت صلاحيته.", "err400": "هذا لا يبدو رابط قائمة. تحقق منه وحاول مجددًا.", "err502": "لم نستطع تحميل قنواتك من مزوّدك. تحقق من الرابط أو بيانات الدخول، ومن أن اشتراكك ما زال فعّالًا.", "errOther": "حدث خطأ ما. حاول مجددًا بعد قليل.", "details": "التفاصيل: ", "wTitle": "كل شيء جاهز", "wEyebrow": "تم استلام الدفع", "wH1": "كل شيء جاهز.", "wLead": "وصولك ساري حتى __UNTIL__. سيصلك إيصال على __EMAIL__.", "wLink": "رابطك الجديد", "wCode": "رمز الوصول", "wKeep": "احتفظ به في مكان آمن. لإعداد جهاز آخر، أدخل بيانات اشتراكك في الصفحة الرئيسية مع هذا الرمز.", "wBack": "العودة إلى الصفحة الرئيسية", "wNext": "الخطوات التالية", "w1": "انسخ رابطك الجديد", "w1t": "موجود أعلاه، كما تم حفظ رمزك في هذا المتصفح.", "w2": "افتح تطبيق المشغّل", "w2t": "ابحث عن مكان إدخال رابط القائمة أو M3U.", "w3": "الصق وشاهد", "w3t": "ستظهر قنواتك كالمعتاد.", "wErr": "لم نستطع تحميل قنواتك بعد. ", "wCopied": "تم النسخ.", "appLink": "احصل على تطبيق rPlay TV من App Store"}, "en": {"title": "Playlist Fixer", "eyebrow": "For rPlay TV on iPhone and CarPlay", "h1": "Play your paid IPTV subscription in your car.", "lead": "Have a paid IPTV subscription that rPlay TV refuses to load? Paste your provider's link here and get a new one the app accepts. Your channels then play on your car screen through CarPlay, and on your iPhone.", "heroCaption": "A live match from a paid subscription, playing through a fixed link in rPlay TV on a car screen.", "before": "Before", "beforeCap": "Your provider's link", "after": "After", "afterCap": "Your new link", "formTitle": "Get your new link", "tabLink": "I have a link", "tabLogin": "I have a username & password", "m3uLabel": "Your playlist link", "m3uHelp": "The link your provider sent you. It usually contains \\"get.php\\".", "hostLabel": "Server address", "userLabel": "Username", "passLabel": "Password", "loginHelp": "Your provider may call these your \\"Xtream\\" details.", "hlsLabel": "Optimise for iPhone and iPad", "hlsHelp": "Recommended. Turn this off only if channels refuse to play.", "keyLabel": "Access code", "keyPh": "Paste your access code", "hint1": "Don't have one yet? Fill in your details above, then ", "buy": "get __DAYS__ days of access__PRICE_EN__", "hint2": ". One code covers one subscription, on all your devices.", "submit": "Get my new link", "outLabel": "Your new link", "copy": "Copy", "stepsTitle": "How it works", "s1": "Paste your provider's link or login", "s1t": "Your details are kept safely so we can help you if something goes wrong. We never share or sell them.", "s2": "Get your new link", "s2t": "It has the same channels as your subscription, delivered in the format iPhone players expect.", "s3": "Add it to rPlay TV", "s3t": "Paste it wherever the app asks for a playlist or M3U link, then watch on your iPhone or in the car through CarPlay.", "faqTitle": "Common questions", "q2": "Will it work with my player app?", "a2": "It is made for rPlay TV on iPhone, iPad and CarPlay, and works with any player that accepts a playlist link. If a channel refuses to play, come back, turn off \\"Optimise for iPhone and iPad\\", and make a fresh link.", "q3": "Why did my provider's link fail in the first place?", "a3": "Many providers send links that iPhone apps block for security reasons. Your new link is delivered in a way those apps accept, with the same channels.", "q4": "Can I watch on several devices?", "a4": "Yes. Use the same link on all of them. How many can play at the same time is set by your provider, not by us.", "q5": "Something isn't working", "a5": "First check that your subscription is still active with your provider. If it is and the link still fails, make a new link here; the problem usually clears.", "footer": "This service passes your channels through as they are. It is not affiliated with any provider or player app.", "errNoLink": "Paste the playlist link from your provider first.", "errNoLogin": "Fill in the server address, username and password.", "errNoCode": "Enter your access code, or get one first.", "checking": "Checking your channels…", "ok": "Your channels load. Copy the link and paste it into your player.", "ready": "Your link is ready. Copy it and paste it into your player.", "copied": "Copied. Now paste it into your player.", "err402": "That access code isn't valid for this subscription, or it has expired.", "err400": "That doesn't look like a playlist link. Check it and try again.", "err502": "We couldn't load your channels from your provider. Check the link or login, and that your subscription is still active.", "errOther": "Something went wrong. Please try again in a moment.", "details": "Details: ", "wTitle": "You're all set", "wEyebrow": "Payment received", "wH1": "You're all set.", "wLead": "Your access runs until __UNTIL__. A receipt is on its way to __EMAIL__.", "wLink": "Your new link", "wCode": "Your access code", "wKeep": "Keep this somewhere safe. To set up another device, enter your subscription details on the front page together with this code.", "wBack": "Back to the front page", "wNext": "Next", "w1": "Copy your new link", "w1t": "It's above. Your code has also been saved in this browser.", "w2": "Open your player app", "w2t": "Find where it asks for a playlist or M3U link.", "w3": "Paste and play", "w3t": "Your channels appear as usual.", "wErr": "We couldn't load your channels yet. ", "wCopied": "Copied.", "appLink": "Get rPlay TV on the App Store"}};
  var lang = 'ar';
  try { lang = localStorage.getItem('lang') === 'en' ? 'en' : 'ar'; } catch (e) {}
  function tr(k) { return I18N[lang][k]; }
  function applyLang(l) {
    lang = l; var d = I18N[l];
    document.documentElement.lang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    document.title = d[document.body.dataset.titleKey];
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = d[el.dataset.i18n]; });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.placeholder = d[el.dataset.i18nPh]; });
    document.querySelectorAll('.lang button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === l)); });
    try { localStorage.setItem('lang', l); } catch (e) {}
  }
  document.querySelectorAll('.lang button').forEach(function (b) { b.addEventListener('click', function () { applyLang(b.dataset.lang); }); });
  applyLang(lang);
  var visitor = '';
  try { visitor = localStorage.getItem('vid') || ''; if (!visitor) { visitor = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('vid', visitor); } } catch (e) {}
  function track(ev) {
    try { fetch('/event', { method: 'POST', keepalive: true, body: JSON.stringify({ event: ev, visitor: visitor, lang: lang, page: location.pathname, referrer: document.referrer }) }).catch(function () {}); } catch (e) {}
  }
  var PAYWALL = __PAYWALL__ === 1;
  track('visit');
  var f = document.getElementById('f'), tabs = f.querySelectorAll('[role=tab]'), panels = f.querySelectorAll('[data-panel]');
  var mode = 'm3u';
  var access = document.getElementById('access'), key = document.getElementById('key');
  var out = document.getElementById('out'), status = document.getElementById('status'), result = document.getElementById('result');
  tabs.forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.dataset.tab;
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === b)); });
      panels.forEach(function (p) { p.hidden = p.dataset.panel !== mode; });
    });
  });
  if (PAYWALL) {
    access.hidden = false;
    try { key.value = localStorage.getItem('access') || ''; } catch (e) {}
    document.getElementById('buy').addEventListener('click', function () {
      track('buy_click');
      var cfg = readCfg();
      if (!cfg) return;
      try { localStorage.setItem('pendingCfg', JSON.stringify(cfg)); } catch (e) {}
      var bf = document.createElement('form'), inp = document.createElement('input');
      bf.method = 'POST'; bf.action = '/buy';
      inp.type = 'hidden'; inp.name = 'cfg'; inp.value = b64url(JSON.stringify(cfg));
      bf.appendChild(inp); document.body.appendChild(bf); bf.submit();
    });
  }
  function b64url(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function readCfg() {
    var cfg = {};
    if (mode === 'm3u') {
      var u = document.getElementById('m3u').value.trim();
      if (!u) { show('', tr('errNoLink'), 'err'); return null; }
      cfg.u = u;
    } else {
      var h = document.getElementById('host').value.trim(), us = document.getElementById('user').value.trim(), p = document.getElementById('pass').value;
      if (!h || !us || !p) { show('', tr('errNoLogin'), 'err'); return null; }
      cfg.x = [h, us, p];
    }
    if (document.getElementById('hls').checked) cfg.h = 1;
    return cfg;
  }
  function friendly(code, detail) {
    if (code === 402) return { msg: tr('err402'), detail: detail };
    if (code === 400) return { msg: tr('err400'), detail: detail };
    if (code === 502) return { msg: tr('err502'), detail: detail };
    return { msg: tr('errOther'), detail: detail };
  }
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    track('generate_click');
    var cfg = readCfg();
    if (!cfg) return;
    if (PAYWALL) {
      var k = key.value.trim();
      if (!k) return show('', tr('errNoCode'), 'err');
      cfg.k = k;
      try { localStorage.setItem('access', k); } catch (e) {}
    }
    var link = location.origin + '/l/' + b64url(JSON.stringify(cfg)) + '/playlist.m3u';
    show(link, tr('checking'), '');
    var enc = b64url(JSON.stringify(cfg));
    fetch(link, { method: 'GET', headers: { range: 'bytes=0-0' } }).then(function (r) {
      report(enc, r.status);
      if (!r.ok) return r.text().then(function (t) { var fr = friendly(r.status, t); show(link, fr.msg, 'err', fr.detail); });
      show(link, tr('ok'), 'ok');
    }).catch(function () { report(enc, 0); show(link, tr('ready'), ''); });
  });
  function report(enc, status) {
    try { fetch('/record', { method: 'POST', keepalive: true, body: JSON.stringify({ cfg: enc, status: status, lang: lang }) }).catch(function () {}); } catch (e) {}
  }
  function show(link, msg, cls, detail) {
    result.hidden = false;
    out.value = link; status.textContent = msg; status.className = 'status ' + cls;
    if (detail) { var d = document.createElement('small'); d.dir = 'ltr'; d.textContent = tr('details') + detail; status.appendChild(d); }
  }
  document.getElementById('copy').addEventListener('click', function () {
    if (!out.value) return;
    (navigator.clipboard ? navigator.clipboard.writeText(out.value) : Promise.reject()).then(function () {
      status.textContent = tr('copied'); status.className = 'status ok';
    }, function () { out.select(); document.execCommand('copy'); });
  });
})();
</script>
</body>
</html>`;

const WELCOME_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<title>كل شيء جاهز</title>
${PAGE_HEAD}
</head>
<body data-title-key="wTitle">
<main>
  <nav class="lang" aria-label="Language">
    <button type="button" data-lang="ar" aria-pressed="true">العربية</button>
    <button type="button" data-lang="en" aria-pressed="false">English</button>
  </nav>
  <section class="hero">
    <p class="eyebrow" data-i18n="wEyebrow">تم استلام الدفع</p>
    <h1 data-i18n="wH1">كل شيء جاهز.</h1>
    <p class="lead" data-i18n="wLead">وصولك ساري حتى __UNTIL__. سيصلك إيصال على __EMAIL__.</p>
  </section>
  <div class="card">
    <div id="ready" hidden>
      <div class="field">
        <label for="link" data-i18n="wLink">رابطك الجديد</label>
        <div class="link">
          <input type="text" id="link" dir="ltr" readonly>
          <button type="button" id="copylink" data-i18n="copy">نسخ</button>
        </div>
        <div class="status" id="lstatus"></div>
      </div>
    </div>
    <div class="field">
      <label for="out" data-i18n="wCode">رمز الوصول</label>
      <div class="link">
        <input type="text" id="out" dir="ltr" readonly value="__CODE__">
        <button type="button" id="copy" data-i18n="copy">نسخ</button>
      </div>
      <div class="status" id="status"></div>
      <p class="help" data-i18n="wKeep">احتفظ به في مكان آمن. لإعداد جهاز آخر، أدخل بيانات اشتراكك في الصفحة الرئيسية مع هذا الرمز.</p>
    </div>
    <a class="primary" href="/" data-i18n="wBack">العودة إلى الصفحة الرئيسية</a>
  </div>
  <section class="steps">
    <h2 data-i18n="wNext">الخطوات التالية</h2>
    <ol>
      <li><div><h3 data-i18n="w1">انسخ رابطك الجديد</h3><p data-i18n="w1t">موجود أعلاه، كما تم حفظ رمزك في هذا المتصفح.</p></div></li>
      <li><div><h3 data-i18n="w2">افتح تطبيق المشغّل</h3><p data-i18n="w2t">ابحث عن مكان إدخال رابط القائمة أو M3U.</p></div></li>
      <li><div><h3 data-i18n="w3">الصق وشاهد</h3><p data-i18n="w3t">ستظهر قنواتك كالمعتاد.</p></div></li>
    </ol>
  </section>
</main>
<script>
(function () {
  var I18N = {"ar": {"title": "إصلاح رابط القنوات", "eyebrow": "لتطبيق rPlay TV على الآيفون وCarPlay", "h1": "شاهد اشتراك IPTV المدفوع في سيارتك.", "lead": "لديك اشتراك IPTV مدفوع لكنه يرفض العمل في تطبيق rPlay TV؟ الصق رابط مزوّدك هنا واحصل على رابط جديد يقبله التطبيق، وتعمل قنواتك على شاشة السيارة عبر CarPlay وعلى الآيفون.", "heroCaption": "مباراة مباشرة من اشتراك مدفوع، تعمل عبر رابط مُعدَّل في تطبيق rPlay TV على شاشة السيارة.", "before": "قبل", "beforeCap": "رابط مزوّدك", "after": "بعد", "afterCap": "رابطك الجديد", "formTitle": "احصل على رابطك الجديد", "tabLink": "لديّ رابط", "tabLogin": "لديّ اسم مستخدم وكلمة مرور", "m3uLabel": "رابط قائمتك", "m3uHelp": "الرابط الذي أرسله لك مزوّدك. عادةً يحتوي على «get.php».", "hostLabel": "عنوان الخادم", "userLabel": "اسم المستخدم", "passLabel": "كلمة المرور", "loginHelp": "قد يسمّيها مزوّدك بيانات «Xtream».", "hlsLabel": "تحسين للآيفون والآيباد", "hlsHelp": "مُوصى به. أوقفه فقط إذا رفضت القنوات العمل.", "keyLabel": "رمز الوصول", "keyPh": "الصق رمز الوصول", "hint1": "ليس لديك رمز بعد؟ أدخل بياناتك أعلاه ثم ", "buy": "احصل على وصول لمدة __DAYS__ يومًا__PRICE_AR__", "hint2": ". رمز واحد يغطي اشتراكًا واحدًا على كل أجهزتك.", "submit": "احصل على رابطي الجديد", "outLabel": "رابطك الجديد", "copy": "نسخ", "stepsTitle": "كيف يعمل", "s1": "الصق رابط مزوّدك أو بيانات دخولك", "s1t": "نحتفظ ببياناتك بأمان لنساعدك إذا حدث خطأ. لا نشاركها ولا نبيعها أبدًا.", "s2": "احصل على رابطك الجديد", "s2t": "يحتوي على نفس قنوات اشتراكك، بالصيغة التي تتوقعها مشغّلات الآيفون.", "s3": "أضفه إلى rPlay TV", "s3t": "الصقه حيث يطلب التطبيق رابط قائمة أو M3U، وشاهد على الآيفون أو في السيارة عبر CarPlay.", "faqTitle": "أسئلة شائعة", "q2": "هل يعمل مع تطبيق المشغّل الخاص بي؟", "a2": "صُمم لتطبيق rPlay TV على الآيفون والآيباد وCarPlay، ويعمل مع أي مشغّل يقبل رابط قائمة. إذا رفضت قناة العمل، عُد هنا وأوقف «تحسين للآيفون والآيباد» وأنشئ رابطًا جديدًا.", "q3": "لماذا فشل رابط مزوّدي من الأساس؟", "a3": "كثير من المزوّدين يرسلون روابط تحجبها تطبيقات الآيفون لأسباب أمنية. رابطك الجديد يُقدَّم بطريقة تقبلها هذه التطبيقات، بنفس القنوات.", "q4": "هل يمكنني المشاهدة على عدة أجهزة؟", "a4": "نعم. استخدم نفس الرابط عليها كلها. أما عدد الأجهزة التي تعمل في نفس الوقت فيحدده مزوّدك، لا نحن.", "q5": "شيء لا يعمل", "a5": "تأكد أولًا أن اشتراكك ما زال فعّالًا لدى مزوّدك. إن كان كذلك واستمر الفشل، أنشئ رابطًا جديدًا هنا؛ غالبًا تُحل المشكلة.", "footer": "هذه الخدمة تمرّر قنواتك كما هي. لا علاقة لها بأي مزوّد أو تطبيق مشغّل.", "errNoLink": "الصق رابط القائمة من مزوّدك أولًا.", "errNoLogin": "أدخل عنوان الخادم واسم المستخدم وكلمة المرور.", "errNoCode": "أدخل رمز الوصول، أو احصل على واحد أولًا.", "checking": "نتحقق من قنواتك…", "ok": "قنواتك تعمل. انسخ الرابط والصقه في مشغّلك.", "ready": "رابطك جاهز. انسخه والصقه في مشغّلك.", "copied": "تم النسخ. الآن الصقه في مشغّلك.", "err402": "رمز الوصول هذا غير صالح لهذا الاشتراك، أو انتهت صلاحيته.", "err400": "هذا لا يبدو رابط قائمة. تحقق منه وحاول مجددًا.", "err502": "لم نستطع تحميل قنواتك من مزوّدك. تحقق من الرابط أو بيانات الدخول، ومن أن اشتراكك ما زال فعّالًا.", "errOther": "حدث خطأ ما. حاول مجددًا بعد قليل.", "details": "التفاصيل: ", "wTitle": "كل شيء جاهز", "wEyebrow": "تم استلام الدفع", "wH1": "كل شيء جاهز.", "wLead": "وصولك ساري حتى __UNTIL__. سيصلك إيصال على __EMAIL__.", "wLink": "رابطك الجديد", "wCode": "رمز الوصول", "wKeep": "احتفظ به في مكان آمن. لإعداد جهاز آخر، أدخل بيانات اشتراكك في الصفحة الرئيسية مع هذا الرمز.", "wBack": "العودة إلى الصفحة الرئيسية", "wNext": "الخطوات التالية", "w1": "انسخ رابطك الجديد", "w1t": "موجود أعلاه، كما تم حفظ رمزك في هذا المتصفح.", "w2": "افتح تطبيق المشغّل", "w2t": "ابحث عن مكان إدخال رابط القائمة أو M3U.", "w3": "الصق وشاهد", "w3t": "ستظهر قنواتك كالمعتاد.", "wErr": "لم نستطع تحميل قنواتك بعد. ", "wCopied": "تم النسخ.", "appLink": "احصل على تطبيق rPlay TV من App Store"}, "en": {"title": "Playlist Fixer", "eyebrow": "For rPlay TV on iPhone and CarPlay", "h1": "Play your paid IPTV subscription in your car.", "lead": "Have a paid IPTV subscription that rPlay TV refuses to load? Paste your provider's link here and get a new one the app accepts. Your channels then play on your car screen through CarPlay, and on your iPhone.", "heroCaption": "A live match from a paid subscription, playing through a fixed link in rPlay TV on a car screen.", "before": "Before", "beforeCap": "Your provider's link", "after": "After", "afterCap": "Your new link", "formTitle": "Get your new link", "tabLink": "I have a link", "tabLogin": "I have a username & password", "m3uLabel": "Your playlist link", "m3uHelp": "The link your provider sent you. It usually contains \\"get.php\\".", "hostLabel": "Server address", "userLabel": "Username", "passLabel": "Password", "loginHelp": "Your provider may call these your \\"Xtream\\" details.", "hlsLabel": "Optimise for iPhone and iPad", "hlsHelp": "Recommended. Turn this off only if channels refuse to play.", "keyLabel": "Access code", "keyPh": "Paste your access code", "hint1": "Don't have one yet? Fill in your details above, then ", "buy": "get __DAYS__ days of access__PRICE_EN__", "hint2": ". One code covers one subscription, on all your devices.", "submit": "Get my new link", "outLabel": "Your new link", "copy": "Copy", "stepsTitle": "How it works", "s1": "Paste your provider's link or login", "s1t": "Your details are kept safely so we can help you if something goes wrong. We never share or sell them.", "s2": "Get your new link", "s2t": "It has the same channels as your subscription, delivered in the format iPhone players expect.", "s3": "Add it to rPlay TV", "s3t": "Paste it wherever the app asks for a playlist or M3U link, then watch on your iPhone or in the car through CarPlay.", "faqTitle": "Common questions", "q2": "Will it work with my player app?", "a2": "It is made for rPlay TV on iPhone, iPad and CarPlay, and works with any player that accepts a playlist link. If a channel refuses to play, come back, turn off \\"Optimise for iPhone and iPad\\", and make a fresh link.", "q3": "Why did my provider's link fail in the first place?", "a3": "Many providers send links that iPhone apps block for security reasons. Your new link is delivered in a way those apps accept, with the same channels.", "q4": "Can I watch on several devices?", "a4": "Yes. Use the same link on all of them. How many can play at the same time is set by your provider, not by us.", "q5": "Something isn't working", "a5": "First check that your subscription is still active with your provider. If it is and the link still fails, make a new link here; the problem usually clears.", "footer": "This service passes your channels through as they are. It is not affiliated with any provider or player app.", "errNoLink": "Paste the playlist link from your provider first.", "errNoLogin": "Fill in the server address, username and password.", "errNoCode": "Enter your access code, or get one first.", "checking": "Checking your channels…", "ok": "Your channels load. Copy the link and paste it into your player.", "ready": "Your link is ready. Copy it and paste it into your player.", "copied": "Copied. Now paste it into your player.", "err402": "That access code isn't valid for this subscription, or it has expired.", "err400": "That doesn't look like a playlist link. Check it and try again.", "err502": "We couldn't load your channels from your provider. Check the link or login, and that your subscription is still active.", "errOther": "Something went wrong. Please try again in a moment.", "details": "Details: ", "wTitle": "You're all set", "wEyebrow": "Payment received", "wH1": "You're all set.", "wLead": "Your access runs until __UNTIL__. A receipt is on its way to __EMAIL__.", "wLink": "Your new link", "wCode": "Your access code", "wKeep": "Keep this somewhere safe. To set up another device, enter your subscription details on the front page together with this code.", "wBack": "Back to the front page", "wNext": "Next", "w1": "Copy your new link", "w1t": "It's above. Your code has also been saved in this browser.", "w2": "Open your player app", "w2t": "Find where it asks for a playlist or M3U link.", "w3": "Paste and play", "w3t": "Your channels appear as usual.", "wErr": "We couldn't load your channels yet. ", "wCopied": "Copied.", "appLink": "Get rPlay TV on the App Store"}};
  var lang = 'ar';
  try { lang = localStorage.getItem('lang') === 'en' ? 'en' : 'ar'; } catch (e) {}
  function tr(k) { return I18N[lang][k]; }
  function applyLang(l) {
    lang = l; var d = I18N[l];
    document.documentElement.lang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    document.title = d[document.body.dataset.titleKey];
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = d[el.dataset.i18n]; });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.placeholder = d[el.dataset.i18nPh]; });
    document.querySelectorAll('.lang button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === l)); });
    try { localStorage.setItem('lang', l); } catch (e) {}
  }
  document.querySelectorAll('.lang button').forEach(function (b) { b.addEventListener('click', function () { applyLang(b.dataset.lang); }); });
  applyLang(lang);
  var visitor = '';
  try { visitor = localStorage.getItem('vid') || ''; if (!visitor) { visitor = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('vid', visitor); } } catch (e) {}
  function track(ev) {
    try { fetch('/event', { method: 'POST', keepalive: true, body: JSON.stringify({ event: ev, visitor: visitor, lang: lang, page: location.pathname, referrer: document.referrer }) }).catch(function () {}); } catch (e) {}
  }
  var out = document.getElementById('out');
  track('welcome_visit');
  try { localStorage.setItem('access', out.value); } catch (e) {}
  function b64url(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function copier(btn, input, st) {
    document.getElementById(btn).addEventListener('click', function () {
      var el = document.getElementById(input), s = document.getElementById(st);
      (navigator.clipboard ? navigator.clipboard.writeText(el.value) : Promise.reject()).then(function () {
        s.textContent = tr('wCopied'); s.className = 'status ok';
      }, function () { el.select(); document.execCommand('copy'); });
    });
  }
  copier('copy', 'out', 'status');
  copier('copylink', 'link', 'lstatus');
  var cfg = null;
  try { cfg = JSON.parse(localStorage.getItem('pendingCfg') || 'null'); } catch (e) {}
  if (cfg && (cfg.u || cfg.x)) {
    cfg.k = out.value;
    var link = location.origin + '/l/' + b64url(JSON.stringify(cfg)) + '/playlist.m3u';
    var ready = document.getElementById('ready'), li = document.getElementById('link'), ls = document.getElementById('lstatus');
    ready.hidden = false; li.value = link; ls.textContent = tr('checking');
    fetch(link, { headers: { range: 'bytes=0-0' } }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { ls.textContent = tr('wErr') + t; ls.className = 'status err'; });
      ls.textContent = tr('ok'); ls.className = 'status ok';
    }).catch(function () { ls.textContent = tr('ready'); ls.className = 'status'; });
  }
})();
</script>
</body>
</html>`;
