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
 *   GET /e/<host>/<path>?sig=<hmac>   relays http://<host>/<path>. Follows redirects,
 *                                     rewrites .m3u8 bodies, streams everything else
 *                                     through. Only hosts this worker signed are
 *                                     accepted, so it is not a general open proxy.
 *   GET /playlist.m3u, /playlist-hls.m3u
 *                                     legacy: redirect to the /l/ link for
 *                                     PLAYLIST_BASE + that name (if PLAYLIST_BASE is set)
 */

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "proxy-authorization", "proxy-authenticate", "host",
]);
const PLAYLIST_TTL = 300; // seconds a generated playlist is cached
const MAX_PLAYLIST_BYTES = 32 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!env.PROXY_SECRET) {
      return text("PROXY_SECRET is not set. Run: npx wrangler secret put PROXY_SECRET", 500);
    }
    const url = new URL(request.url);
    const self = `${url.protocol}//${url.host}`;

    if (url.pathname === "/") return landingPage();

    const gen = url.pathname.match(/^\/l\/([A-Za-z0-9_-]+)\/playlist\.m3u$/);
    if (gen) {
      let cfg;
      try { cfg = parseConfig(gen[1]); } catch (e) { return text(`bad link: ${e.message}`, 400); }
      return cachedPlaylist(request, ctx, () => generatePlaylist(cfg, self, env));
    }

    if (url.pathname.startsWith("/e/")) {
      const rest = url.pathname.slice(3);
      const slash = rest.indexOf("/");
      if (slash < 0) return text("bad edge path", 400);
      const host = rest.slice(0, slash);
      const sig = url.searchParams.get("sig") || "";
      url.searchParams.delete("sig");
      if (!(await verify(env, host, sig))) return text("bad signature", 403);
      return proxyStream(request, `http://${rest}${url.search}`, self, env);
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

async function generatePlaylist(cfg, self, env) {
  let source;
  try {
    source = cfg.xtream ? await buildXtreamPlaylist(cfg.xtream, cfg.hls) : await fetchSourcePlaylist(cfg.source);
  } catch (e) {
    return text(`could not load source playlist: ${e.message}`, 502);
  }
  if (!source.trimStart().startsWith("#EXTM3U")) {
    return text("source does not look like an M3U playlist (no #EXTM3U header)", 502);
  }
  const body = await rewritePlaylist(source, self, env, { hls: cfg.hls });
  return new Response(body, {
    headers: {
      "content-type": "application/x-mpegurl; charset=utf-8",
      "content-disposition": 'inline; filename="playlist.m3u"',
      "cache-control": `public, max-age=${PLAYLIST_TTL}`,
      "access-control-allow-origin": "*",
    },
  });
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
export async function rewritePlaylist(textBody, self, env, { hls = false } = {}) {
  const selfHost = new URL(self).host.toLowerCase();
  const sigs = new Map();
  for (const [, host] of textBody.matchAll(STREAM_LINE_RE)) {
    const h = host.toLowerCase();
    if (!sigs.has(h) && h !== selfHost && !isPrivateHost(hostnameOf(h))) sigs.set(h, null);
  }
  await Promise.all([...sigs.keys()].map(async (h) => sigs.set(h, await sign(env, h))));

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
    return `${prefix}${host}${rest}${q < 0 ? "?" : "&"}sig=${sig}`;
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

async function proxyStream(request, upstream, self, env) {
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
    const body = await rewriteHls(await res.text(), finalUrl, self, hostSigner(env));
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
  return `${self}/e/${abs.host}${abs.pathname}${abs.search}${sep}sig=${await signer(abs.host)}`;
}

// ---------------------------------------------------------------------------
// Signing. The signature covers the upstream host only (not the full URL): a
// playlist with 16k channels would otherwise need 16k HMACs per request, and
// per-URL signing buys nothing extra here because anyone holding the playlist
// can already reach every path on that host through the provider directly.

let keyCache = null;
async function hmacKey(env) {
  if (keyCache && keyCache.secret === env.PROXY_SECRET) return keyCache.key;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.PROXY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  keyCache = { secret: env.PROXY_SECRET, key };
  return key;
}

async function sign(env, host) {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(host.toLowerCase()));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns sign() memoised per host, for one request's worth of rewriting. */
function hostSigner(env) {
  const memo = new Map();
  return async (host) => {
    let s = memo.get(host);
    if (!s) { s = await sign(env, host); memo.set(host, s); }
    return s;
  };
}

async function verify(env, host, sig) {
  if (!/^[0-9a-f]{32}$/.test(sig)) return false;
  const expected = await sign(env, host);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
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
// Landing page

function landingPage() {
  return new Response(LANDING_HTML, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IPTV HTTPS link</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #1a1c20; --muted: #5c6370; --line: #d9dde3; --accent: #2563eb; --ok: #15803d; --err: #b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --card: #181b21; --fg: #e6e8eb; --muted: #9aa3ad; --line: #2b313a; --accent: #60a5fa; --ok: #4ade80; --err: #f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 620px; margin: 0 auto; padding: 40px 20px 60px; }
  h1 { font-size: 1.6rem; margin: 0 0 6px; }
  .lead { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 16px; }
  .tabs button { flex: 1; padding: 9px; border: 1px solid var(--line); background: transparent; color: var(--fg); border-radius: 8px; cursor: pointer; font: inherit; }
  .tabs button[aria-selected="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  label { display: block; font-size: .85rem; color: var(--muted); margin: 12px 0 4px; }
  input[type=text], input[type=url], input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
  .check { display: flex; gap: 10px; align-items: flex-start; margin: 16px 0; font-size: .9rem; }
  .check input { margin-top: 4px; }
  .check small { display: block; color: var(--muted); }
  .primary { width: 100%; padding: 12px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  #result { margin-top: 20px; display: none; }
  .link { display: flex; gap: 8px; }
  .link input { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  .link button { padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); cursor: pointer; font: inherit; }
  .status { margin-top: 10px; font-size: .9rem; min-height: 1.4em; }
  .ok { color: var(--ok); } .err { color: var(--err); }
  footer { margin-top: 28px; font-size: .85rem; color: var(--muted); }
  footer p { margin: 6px 0; }
</style>
</head>
<body>
<main>
  <h1>IPTV HTTPS link</h1>
  <p class="lead">Turn a plain-HTTP IPTV playlist into an HTTPS link that iOS players such as rPlayTV will accept. Channels are relayed through this server.</p>

  <form class="card" id="f">
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-tab="m3u">M3U URL</button>
      <button type="button" role="tab" aria-selected="false" data-tab="xtream">Xtream login</button>
    </div>

    <section data-panel="m3u">
      <label for="m3u">Playlist URL</label>
      <input type="url" id="m3u" placeholder="http://provider.example/get.php?username=…&password=…&type=m3u_plus" autocomplete="off" spellcheck="false">
    </section>

    <section data-panel="xtream" hidden>
      <label for="host">Server</label>
      <input type="text" id="host" placeholder="http://provider.example:8080" autocomplete="off" spellcheck="false">
      <label for="user">Username</label>
      <input type="text" id="user" autocomplete="off" spellcheck="false">
      <label for="pass">Password</label>
      <input type="password" id="pass" autocomplete="off">
    </section>

    <label class="check"><input type="checkbox" id="hls" checked>
      <span>Convert <code>.ts</code> streams to HLS (<code>.m3u8</code>)<small>Recommended on iOS. Untick if channels fail to play.</small></span>
    </label>

    <button class="primary" type="submit">Generate link</button>

    <div id="result">
      <label for="out">Paste this into your player</label>
      <div class="link">
        <input type="text" id="out" readonly>
        <button type="button" id="copy">Copy</button>
      </div>
      <div class="status" id="status"></div>
    </div>
  </form>

  <footer>
    <p>The link contains your playlist URL or login, so treat it like a password. Nothing is stored on the server; each link is regenerated from your provider on demand (cached for 5 minutes).</p>
    <p>Your provider's connection limit still applies: the relay makes one upstream connection per stream being played.</p>
  </footer>
</main>
<script>
(function () {
  var f = document.getElementById('f'), tabs = f.querySelectorAll('[role=tab]'), panels = f.querySelectorAll('[data-panel]');
  var mode = 'm3u';
  tabs.forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.dataset.tab;
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === b)); });
      panels.forEach(function (p) { p.hidden = p.dataset.panel !== mode; });
    });
  });
  function b64url(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  var out = document.getElementById('out'), status = document.getElementById('status'), result = document.getElementById('result');
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var cfg = {};
    if (mode === 'm3u') {
      var u = document.getElementById('m3u').value.trim();
      if (!u) return show('', 'Enter a playlist URL.', 'err');
      cfg.u = u;
    } else {
      var h = document.getElementById('host').value.trim(), us = document.getElementById('user').value.trim(), p = document.getElementById('pass').value;
      if (!h || !us || !p) return show('', 'Server, username and password are all required.', 'err');
      cfg.x = [h, us, p];
    }
    if (document.getElementById('hls').checked) cfg.h = 1;
    var link = location.origin + '/l/' + b64url(JSON.stringify(cfg)) + '/playlist.m3u';
    show(link, 'Checking…', '');
    fetch(link, { method: 'GET', headers: { range: 'bytes=0-0' } }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { show(link, 'Error ' + r.status + ': ' + t, 'err'); });
      show(link, 'Playlist loads. Paste the link into your player.', 'ok');
    }).catch(function () { show(link, 'Link generated (could not verify from this browser).', ''); });
  });
  function show(link, msg, cls) {
    result.style.display = 'block';
    out.value = link; status.textContent = msg; status.className = 'status ' + cls;
  }
  document.getElementById('copy').addEventListener('click', function () {
    if (!out.value) return;
    (navigator.clipboard ? navigator.clipboard.writeText(out.value) : Promise.reject()).then(function () {
      status.textContent = 'Copied.'; status.className = 'status ok';
    }, function () { out.select(); document.execCommand('copy'); });
  });
})();
</script>
</body>
</html>`;
