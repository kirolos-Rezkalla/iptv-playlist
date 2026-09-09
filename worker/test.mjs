// End-to-end test of the worker in Node: a fake provider on localhost, with
// global fetch patched so "provider.test" / "edge.test" resolve to it.
import http from "node:http";
import assert from "node:assert/strict";
import worker, { encodeConfig, linkPath } from "./src/index.js";

const M3U = `#EXTM3U x-tvg-url=""
#EXTINF:-1 tvg-id="" tvg-name="One" tvg-logo="http://logo.test/1.png" group-title="G",One
http://provider.test/live/u/p/1.ts
#EXTINF:-1 tvg-name="Two",Two
https://secure.test/live/2.m3u8
#EXTINF:-1 tvg-name="Three",Three
http://provider.test/live/u/p/3.ts?token=abc
`;
const HLS = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
seg1.ts
http://edge.test/other/seg2.ts
`;
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(`${req.headers.host}${req.url}`);
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/list.m3u") return res.end(M3U);
  if (u.pathname === "/live/u/p/1.m3u8") return res.writeHead(302, { location: "http://edge.test/hls/1/index.m3u8" }).end();
  if (u.pathname === "/hls/1/index.m3u8") return res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end(HLS);
  if (u.pathname === "/hls/1/seg1.ts") return res.writeHead(200, { "content-type": "video/mp2t" }).end(Buffer.from([0x47, 1, 2, 3]));
  if (u.pathname === "/player_api.php") {
    if (u.searchParams.get("password") !== "pw") return res.end(JSON.stringify({ user_info: { auth: 0 } }));
    const a = u.searchParams.get("action");
    if (a === "get_live_categories") return res.end(JSON.stringify([{ category_id: "7", category_name: 'Cat "A"' }]));
    if (a === "get_live_streams") return res.end(JSON.stringify([
      { num: 2, name: "B", stream_id: 22, category_id: "7", stream_icon: "", epg_channel_id: "b.id" },
      { num: 1, name: "A\nx", stream_id: 11, category_id: "99", stream_icon: "http://l/x.png", epg_channel_id: null },
    ]));
  }
  res.writeHead(404).end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (["provider.test", "edge.test"].includes(u.hostname)) {
    const h = new Headers(init?.headers); h.set("host", u.host);
    u.protocol = "http:"; u.host = `127.0.0.1:${port}`;
    return realFetch(u, { ...init, headers: h, redirect: "manual" }).then(async (r) => {
      if ((init?.redirect ?? "follow") === "follow" && r.status >= 300 && r.status < 400) {
        const loc = new URL(r.headers.get("location"), `http://${h.get("host")}`);
        const r2 = await globalThis.fetch(loc.href, init);
        Object.defineProperty(r2, "url", { value: loc.href });
        return r2;
      }
      return r;
    });
  }
  throw new Error(`unexpected outbound fetch: ${u.href}`);
};
const store = new Map();
globalThis.caches = { default: {
  match: async (k) => store.get(k.url)?.clone(),
  put: async (k, r) => { store.set(k.url, r); },
} };

const env = { PROXY_SECRET: "test-secret", PLAYLIST_BASE: "http://provider.test" };
const ctx = { waitUntil: (p) => p };
const SELF = "https://relay.example";
const call = (path, init) => worker.fetch(new Request(`${SELF}${path}`, init), env, ctx);

// landing page
let r = await call("/");
assert.equal(r.status, 200); assert.match(await r.text(), /<form/);

// missing secret
r = await worker.fetch(new Request(`${SELF}/`), {}, ctx);
assert.equal(r.status, 500);

// generated playlist from an m3u url, no hls conversion
r = await call(linkPath({ u: "http://provider.test/list.m3u" }));
assert.equal(r.status, 200, await r.clone().text());
let body = await r.text();
const lines = body.trim().split("\n");
assert.equal(lines[0], '#EXTM3U x-tvg-url=""');
assert.match(lines[2], /^https:\/\/relay\.example\/e\/provider\.test\/live\/u\/p\/1\.ts\?sig=[0-9a-f]{32}$/);
assert.equal(lines[4], "https://secure.test/live/2.m3u8", "https streams are left alone");
assert.match(lines[6], /^https:\/\/relay\.example\/e\/provider\.test\/live\/u\/p\/3\.ts\?token=abc&sig=[0-9a-f]{32}$/);
const sig = lines[2].split("sig=")[1];
assert.equal(lines[6].split("sig=")[1], sig, "same host => same signature");

// cache hit: second call doesn't hit the provider
const before = requests.length;
r = await call(linkPath({ u: "http://provider.test/list.m3u" }));
assert.equal(await r.text(), body); assert.equal(requests.length, before, "served from cache");

// hls conversion
r = await call(linkPath({ u: "http://provider.test/list.m3u", h: 1 }));
body = await r.text();
assert.match(body, /\/e\/provider\.test\/live\/u\/p\/1\.m3u8\?sig=/);
assert.match(body, /\/e\/provider\.test\/live\/u\/p\/3\.m3u8\?token=abc&sig=/);

// relay: .m3u8 through provider 302 -> edge, body rewritten, key URI rewritten
r = await call(`/e/provider.test/live/u/p/1.m3u8?sig=${sig}`);
assert.equal(r.status, 200, await r.clone().text());
assert.equal(r.headers.get("content-type"), "application/vnd.apple.mpegurl");
body = await r.text();
assert.match(body, /#EXT-X-KEY:METHOD=AES-128,URI="https:\/\/relay\.example\/e\/edge\.test\/hls\/1\/key\.bin\?sig=[0-9a-f]{32}"/);
assert.match(body, /^https:\/\/relay\.example\/e\/edge\.test\/hls\/1\/seg1\.ts\?sig=([0-9a-f]{32})$/m);
assert.match(body, /^https:\/\/relay\.example\/e\/edge\.test\/other\/seg2\.ts\?sig=/m);
const edgeSig = body.match(/seg1\.ts\?sig=([0-9a-f]{32})/)[1];
assert.notEqual(edgeSig, sig, "different host => different signature");

// relay: binary segment passes through
r = await call(`/e/edge.test/hls/1/seg1.ts?sig=${edgeSig}`);
assert.equal(r.status, 200);
assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0x47, 1, 2, 3]);
assert.equal(r.headers.get("content-type"), "video/mp2t");

// relay: wrong/forged signatures are rejected, and sig for one host doesn't open another
assert.equal((await call(`/e/edge.test/hls/1/seg1.ts?sig=${sig}`)).status, 403);
assert.equal((await call(`/e/edge.test/hls/1/seg1.ts?sig=deadbeef`)).status, 403);
assert.equal((await call(`/e/edge.test/hls/1/seg1.ts`)).status, 403);
assert.equal((await call(`/e/nopath`)).status, 400);

// xtream mode
r = await call(linkPath({ x: ["provider.test", "usr", "pw"], h: 1 }));
assert.equal(r.status, 200, await r.clone().text());
body = await r.text();
const xl = body.trim().split("\n");
assert.equal(xl.length, 5);
assert.equal(xl[1], `#EXTINF:-1 tvg-id="" tvg-name="A x" tvg-logo="http://l/x.png" group-title="Uncategorized",A x`, "sorted by num, cleaned, missing category");
assert.match(xl[2], /^https:\/\/relay\.example\/e\/provider\.test\/live\/usr\/pw\/11\.m3u8\?sig=/);
assert.equal(xl[3], `#EXTINF:-1 tvg-id="b.id" tvg-name="B" tvg-logo="" group-title="Cat 'A'",B`);
// xtream bad credentials -> readable error
r = await call(linkPath({ x: ["provider.test", "usr", "wrong"] }));
assert.equal(r.status, 502); assert.match(await r.text(), /bad credentials/);

// bad links
assert.equal((await call("/l/!!!/playlist.m3u")).status, 404);
assert.equal((await call(`/l/${encodeConfig({})}/playlist.m3u`)).status, 400);
assert.equal((await call(`/l/${encodeConfig({ u: "ftp://x/y" })}/playlist.m3u`)).status, 400);
for (const h of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "[::1]", "localhost", "foo.internal"]) {
  r = await call(`/l/${encodeConfig({ u: `http://${h}/x.m3u` })}/playlist.m3u`);
  assert.equal(r.status, 400, `private host ${h} should be rejected`);
}
// source that isn't an m3u
r = await call(linkPath({ u: "http://provider.test/missing" }));
assert.equal(r.status, 502);

// legacy redirect
r = await call("/playlist-hls.m3u");
assert.equal(r.status, 302);
assert.equal(r.headers.get("location"), `${SELF}${linkPath({ u: "http://provider.test/playlist-hls.m3u" })}`);

// method
assert.equal((await call("/", { method: "POST" })).status, 405);

server.close();
console.log("ALL TESTS PASSED");
