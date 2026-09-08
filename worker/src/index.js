/**
 * HTTPS proxy for an HTTP-only Xtream Codes IPTV provider.
 *
 * Routes:
 *   GET /playlist.m3u        -> provider playlist (from GitHub raw) with every
 *                               stream URL rewritten to go through this worker
 *   GET /playlist-hls.m3u    -> same, HLS variant
 *   GET /p/<path>            -> http://<PROVIDER_HOST>/<path>   (follows redirects,
 *                               rewrites .m3u8 bodies, streams .ts through)
 *   GET /e/<host>/<path>?sig -> http://<host>/<path>            (edge/segment host;
 *                               only HMAC-signed URLs issued by this worker)
 */

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "proxy-authorization", "proxy-authenticate", "host",
]);

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const url = new URL(request.url);
    const self = `${url.protocol}//${url.host}`;

    if (url.pathname === "/playlist.m3u" || url.pathname === "/playlist-hls.m3u") {
      return proxiedPlaylist(env, self, url.pathname);
    }
    if (url.pathname.startsWith("/p/")) {
      const upstream = `http://${env.PROVIDER_HOST}/${url.pathname.slice(3)}${url.search}`;
      return proxyStream(request, upstream, self, env);
    }
    if (url.pathname.startsWith("/e/")) {
      // /e/<host>/<path>?...&sig=<hmac>  - only URLs this worker signed are proxied,
      // so the edge route cannot be used as an open proxy.
      const rest = url.pathname.slice(3);
      const slash = rest.indexOf("/");
      if (slash < 0) return new Response("bad edge path", { status: 400 });
      const sig = url.searchParams.get("sig") || "";
      url.searchParams.delete("sig");
      const target = `http://${rest}${url.search}`;
      if (!(await verify(env, target, sig))) return new Response("bad signature", { status: 403 });
      return proxyStream(request, target, self, env);
    }
    return new Response("iptv proxy: use /playlist.m3u or /playlist-hls.m3u", {
      status: 404, headers: { "content-type": "text/plain" },
    });
  },
};

async function hmacKey(env) {
  const secret = env.PROXY_SECRET || "change-me";
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

async function sign(env, target) {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(target));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verify(env, target, sig) {
  if (!/^[0-9a-f]{32}$/.test(sig)) return false;
  const expected = await sign(env, target);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function proxiedPlaylist(env, self, name) {
  const src = `${env.PLAYLIST_BASE}${name}`;
  const res = await fetch(src, { cf: { cacheTtl: 300 } });
  if (!res.ok) return new Response(`upstream playlist ${res.status}`, { status: 502 });
  const text = await res.text();
  const re = new RegExp(`^http://${escapeRe(env.PROVIDER_HOST)}(?::\\d+)?/`, "gm");
  const body = text.replace(re, `${self}/p/`);
  return new Response(body, {
    headers: {
      "content-type": "application/x-mpegurl; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

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
    return new Response(`upstream fetch failed: ${e.message}`, { status: 502 });
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
    const text = await res.text();
    const rewritten = await rewriteHls(text, finalUrl, self, env);
    out.delete("content-length");
    out.set("content-type", "application/vnd.apple.mpegurl");
    out.set("cache-control", "no-cache");
    return new Response(rewritten, { status: res.status, headers: out });
  }

  // Binary stream (MPEG-TS, segments): pass the body through untouched.
  return new Response(res.body, { status: res.status, headers: out });
}

async function rewriteHls(text, base, self, env) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }
    if (t.startsWith("#")) {
      // Rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA).
      const uris = [...t.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]);
      let s = t;
      for (const u of uris) s = s.replace(`URI="${u}"`, `URI="${await toProxy(u, base, self, env)}"`);
      out.push(s);
      continue;
    }
    out.push(await toProxy(t, base, self, env));
  }
  return out.join("\n");
}

async function toProxy(ref, base, self, env) {
  let abs;
  try { abs = new URL(ref, base); } catch { return ref; }
  if (abs.host === new URL(self).host) return abs.toString();
  const target = `http://${abs.host}${abs.pathname}${abs.search}`;
  const sig = await sign(env, target);
  const sep = abs.search ? "&" : "?";
  return `${self}/e/${abs.host}${abs.pathname}${abs.search}${sep}sig=${sig}`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
