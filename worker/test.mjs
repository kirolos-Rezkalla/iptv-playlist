// End-to-end test of the worker in Node: a fake provider on localhost, with
// global fetch patched so "provider.test" / "edge.test" resolve to it.
import http from "node:http";
import assert from "node:assert/strict";
import worker, { encodeConfig, linkPath, mintAccess, verifyAccess, parseConfig, sourceHash } from "./src/index.js";
import { _setSqlFactory, databaseUrl } from "./src/db.js";

// Hyperdrive binding wins over a direct URL
assert.equal(databaseUrl({ HYPERDRIVE: { connectionString: "postgresql://h" }, DATABASE_URL: "postgresql://d" }), "postgresql://h");
assert.equal(databaseUrl({ DATABASE_URL: "postgresql://d" }), "postgresql://d");
assert.equal(databaseUrl({}), null);

// fake SQL client: records every INSERT's table and row
const dbRows = [];
_setSqlFactory(() => ({
  connect: async () => {},
  insert: async (table, row) => { dbRows.push({ table, row }); return { rowCount: 1 }; },
  end: async () => {},
}));
const realError = console.error;
console.error = (...a) => { throw new Error("unexpected console.error: " + a.join(" ")); }; // db errors must not be swallowed silently in tests

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
  if (u.pathname === "/get.php") return res.writeHead(884).end(); // Xtream panels that refuse get.php
  if (u.pathname === "/html/get.php") return res.end("<html>login</html>");
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

// fake Stripe: remembers the metadata of the last created session and reports it paid
const stripeCalls = [];
const SESSION_CREATED = 1_800_000_000;
let lastMetadata = {};
function fakeStripe(u, init) {
  stripeCalls.push({ method: init?.method || "GET", path: u.pathname, body: init?.body, auth: new Headers(init?.headers).get("authorization") });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (u.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    lastMetadata = {};
    for (const [k, v] of new URLSearchParams(init.body)) { const m = k.match(/^metadata\[(\w+)\]$/); if (m) lastMetadata[m[1]] = v; }
    return json({ id: "cs_test_new", url: "https://checkout.stripe.test/pay/cs_test_new" });
  }
  if (u.pathname === "/v1/checkout/sessions/cs_test_new") {
    return json({ id: "cs_test_new", payment_status: "paid", created: SESSION_CREATED, metadata: lastMetadata, customer_details: { email: "buyer@example.com" } });
  }
  if (u.pathname === "/v1/checkout/sessions/cs_test_paid") { // paid, but not bound to a playlist
    return json({ id: "cs_test_paid", payment_status: "paid", created: SESSION_CREATED, metadata: {}, customer_details: { email: "buyer@example.com" } });
  }
  if (u.pathname === "/v1/checkout/sessions/cs_test_open") return json({ id: "cs_test_open", payment_status: "unpaid", created: SESSION_CREATED });
  return json({ error: { message: "No such checkout.session" } }, 404);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "api.stripe.com") return Promise.resolve(fakeStripe(u, init));
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
assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8", "served like a static file, not as a media type");
assert.equal(r.headers.get("accept-ranges"), "bytes");

// range requests behave like a static file host
r = await call(linkPath({ u: "http://provider.test/list.m3u" }), { headers: { range: "bytes=0-6" } });
assert.equal(r.status, 206);
assert.equal(await r.text(), "#EXTM3U");
assert.equal(r.headers.get("content-range"), `bytes 0-6/${Buffer.byteLength(body)}`);
assert.equal(r.headers.get("content-length"), "7");
r = await call(linkPath({ u: "http://provider.test/list.m3u" }), { headers: { range: "bytes=999999-" } });
assert.equal(r.status, 416);
r = await call(linkPath({ u: "http://provider.test/list.m3u" }), { method: "HEAD" });
assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8"); // workerd drops the body for HEAD

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

// m3u url is a get.php that the provider refuses -> fall back to the Xtream API with the same credentials
r = await call(linkPath({ u: "http://provider.test/get.php?username=usr&password=pw&type=m3u_plus&output=ts", h: 1 }));
assert.equal(r.status, 200, await r.clone().text());
body = await r.text();
assert.equal(body.trim().split("\n").length, 5);
assert.match(body, /\/e\/provider\.test\/live\/usr\/pw\/11\.m3u8\?sig=/, "built from player_api with get.php's credentials");
// get.php returns something that is not an M3U -> same fallback
r = await call(linkPath({ u: "http://provider.test/html/get.php?username=usr&password=pw" }));
assert.equal(r.status, 200, await r.clone().text());
assert.match(await r.text(), /\/live\/usr\/pw\/11\.ts\?sig=/);
// fallback with wrong credentials reports both failures
r = await call(linkPath({ u: "http://provider.test/get.php?username=usr&password=nope" }));
assert.equal(r.status, 502);
assert.match(await r.text(), /HTTP 884.*also tried the Xtream API.*bad credentials/);
// a get.php url without credentials does not fall back
r = await call(linkPath({ u: "http://provider.test/get.php?type=m3u" }));
assert.equal(r.status, 502); assert.doesNotMatch(await r.text(), /Xtream/);

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
assert.equal((await call("/", { method: "PUT" })).status, 405);

const formPost = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const LIST = { u: "http://provider.test/list.m3u" };
const listSrc = await sourceHash(parseConfig(encodeConfig(LIST)));

// inline scripts must be valid JS (the pages are template literals, so escaping mistakes end up here)
function checkScripts(html, name) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, `${name}: has a script`);
  for (const src of scripts) new Function(src); // throws SyntaxError if broken
}
checkScripts(await (await call("/")).text(), "landing");

// /record: no database configured -> accepted and dropped; bad input -> 400
assert.equal((await call("/record", { method: "POST", body: JSON.stringify({ cfg: encodeConfig(LIST), status: 200, lang: "ar" }) })).status, 204);
assert.equal(dbRows.length, 0, "nothing stored without DATABASE_URL");
assert.equal((await call("/record", { method: "POST", body: "nope" })).status, 400);
assert.equal((await call("/record", { method: "POST", body: JSON.stringify({ cfg: encodeConfig({}) }) })).status, 400);
assert.equal((await call("/record", { method: "POST", body: JSON.stringify({}) })).status, 400);

// /event: page views and clicks
assert.equal((await call("/event", { method: "POST", body: JSON.stringify({ event: "visit", visitor: "abc123xyz" }) })).status, 204);
assert.equal((await call("/event", { method: "POST", body: JSON.stringify({ event: "hack" }) })).status, 400);
assert.equal((await call("/event", { method: "POST", body: "{" })).status, 400);
assert.equal(dbRows.length, 0);
body = await (await call("/")).text();
assert.match(body, /track\('visit'\)/); assert.match(body, /track\('generate_click'\)/); assert.match(body, /track\('buy_click'\)/);

// /record with a database: the entered details, the code's owner and the check result are stored
const denv = { ...env, DATABASE_URL: "postgresql://fake" };
const dcall = (path, init) => worker.fetch(new Request(`${SELF}${path}`, init), denv, ctx);
r = await dcall("/record", { method: "POST", body: JSON.stringify({ cfg: encodeConfig({ x: ["provider.test", "usr", "pw"], h: 1 }), status: 200, lang: "en" }) });
assert.equal(r.status, 204);
assert.equal(dbRows.length, 1);
assert.deepEqual({ ...dbRows[0].row, source_hash: "x" }, {
  kind: "xtream", m3u_url: null, xtream_host: "http://provider.test", xtream_user: "usr", xtream_pass: "pw", hls: true, source_hash: "x",
  access_email: null, access_ref: null, master: false, result_status: 200, lang: "en", ip: null, country: null, user_agent: null,
});
assert.equal(dbRows[0].table, "submissions");
r = await dcall("/record", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "UA" }, body: JSON.stringify({ cfg: encodeConfig(LIST), status: 502, lang: "xx" }) });
assert.equal(dbRows.length, 2);
assert.equal(dbRows[1].row.kind, "m3u"); assert.equal(dbRows[1].row.m3u_url, "http://provider.test/list.m3u");
assert.equal(dbRows[1].row.ip, "203.0.113.9"); assert.equal(dbRows[1].row.user_agent, "UA"); assert.equal(dbRows[1].row.lang, null);
assert.equal(dbRows[1].row.result_status, 502);
r = await dcall("/event", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ event: "generate_click", visitor: "abc123xyz", lang: "ar", page: "/", referrer: "https://google.com/" }) });
assert.equal(r.status, 204); assert.equal(dbRows.length, 3); assert.equal(dbRows[2].table, "events");
assert.deepEqual(dbRows[2].row, { event: "generate_click", visitor: "abc123xyz", lang: "ar", page: "/", referrer: "https://google.com/", ip: "203.0.113.9", country: null, user_agent: null });
await dcall("/event", { method: "POST", body: JSON.stringify({ event: "visit", visitor: "bad visitor!", lang: "fr", referrer: "" }) });
assert.deepEqual(dbRows[3].row, { event: "visit", visitor: null, lang: null, page: null, referrer: null, ip: null, country: null, user_agent: null });
dbRows.length = 0;

// paywall off: buy/welcome are not available, landing page hides the access section
assert.equal((await call("/buy", formPost({ cfg: encodeConfig(LIST) }))).status, 404);
assert.equal((await call("/welcome?session_id=cs_test_paid")).status, 404);
assert.match(await (await call("/")).text(), /var PAYWALL = 0 === 1/);

// ---------------------------------------------------------------------------
// paywall on
const penv = { ...env, PAYWALL: "1", STRIPE_SECRET_KEY: "sk_test_123", STRIPE_PRICE_ID: "price_abc", ACCESS_DAYS: "30" };
const pcall = (path, init) => worker.fetch(new Request(`${SELF}${path}`, init), penv, ctx);

// landing page shows the access section and the configured duration
body = await (await pcall("/")).text();
assert.match(body, /var PAYWALL = 1 === 1/); assert.match(body, /get 30 days of access/); assert.match(body, /احصل على وصول لمدة 30 يومًا/); assert.match(body, /<html lang="ar" dir="rtl">/);

// a link without an access code is refused
r = await pcall(linkPath({ u: "http://provider.test/list.m3u" }));
assert.equal(r.status, 402); assert.match(await r.text(), /access code/);
r = await pcall(linkPath({ u: "http://provider.test/list.m3u", k: "garbage.deadbeef" }));
assert.equal(r.status, 402);

// buy needs the playlist details
assert.equal((await pcall("/buy", { method: "POST" })).status, 400);
assert.equal((await pcall("/buy", formPost({ cfg: encodeConfig({}) }))).status, 400);
assert.equal((await pcall("/buy", formPost({ cfg: encodeConfig({ u: "http://127.0.0.1/x.m3u" }) }))).status, 400);

// buy -> Stripe Checkout, with the source hash in the session metadata
r = await pcall("/buy", formPost({ cfg: encodeConfig({ ...LIST, h: 1 }) }));
assert.equal(r.status, 303);
assert.equal(r.headers.get("location"), "https://checkout.stripe.test/pay/cs_test_new");
const created = stripeCalls.find((c) => c.method === "POST");
assert.equal(created.auth, "Bearer sk_test_123");
const form = new URLSearchParams(created.body);
assert.equal(form.get("mode"), "payment");
assert.equal(form.get("line_items[0][price]"), "price_abc");
assert.equal(form.get("metadata[src]"), listSrc, "hash of the source, hls flag ignored");
assert.equal(form.has("metadata[cfg]"), false, "credentials never go to Stripe");
assert.equal(form.get("success_url"), `${SELF}/welcome?session_id={CHECKOUT_SESSION_ID}`);
assert.equal(form.get("cancel_url"), `${SELF}/`);

// welcome: unpaid session, bad id, unknown session, paid-but-unbound session, paid bound session
assert.equal((await pcall("/welcome?session_id=cs_test_open")).status, 402);
assert.equal((await pcall("/welcome?session_id=nope")).status, 400);
assert.equal((await pcall("/welcome?session_id=cs_test_missing")).status, 502);
assert.equal((await pcall("/welcome?session_id=cs_test_paid")).status, 500);
r = await pcall("/welcome?session_id=cs_test_new");
assert.equal(r.status, 200, await r.clone().text());
assert.equal(r.headers.get("cache-control"), "private, no-store");
body = await r.text();
checkScripts(body, "welcome");
const code = body.match(/id="out" dir="ltr" readonly value="([^"]+)"/)[1];
const access = await verifyAccess(penv, code, SESSION_CREATED + 1);
assert.deepEqual(access, { email: "buyer@example.com", exp: SESSION_CREATED + 30 * 86400, ref: "cs_test_new", src: listSrc });
assert.match(body, new RegExp(new Date(access.exp * 1000).toISOString().slice(0, 10)));
// revisiting yields the same code (deterministic)
assert.match(await (await pcall("/welcome?session_id=cs_test_new")).text(), new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

// with a database: welcome stores the purchase once; a recorded link carries the code's owner
const pdenv = { ...penv, DATABASE_URL: "postgresql://fake" };
const pdcall = (path, init) => worker.fetch(new Request(`${SELF}${path}`, init), pdenv, ctx);
dbRows.length = 0;
assert.equal((await pdcall("/welcome?session_id=cs_test_new")).status, 200);
assert.equal(dbRows.length, 1); assert.equal(dbRows[0].table, "purchases");
assert.deepEqual({ ...dbRows[0].row, expires_at: dbRows[0].row.expires_at.toISOString(), paid_at: dbRows[0].row.paid_at.toISOString() }, {
  stripe_session_id: "cs_test_new", email: "buyer@example.com", source_hash: listSrc, amount_total: null, currency: null,
  paid_at: new Date(SESSION_CREATED * 1000).toISOString(), expires_at: new Date((SESSION_CREATED + 30 * 86400) * 1000).toISOString(), ip: null, country: null,
});
r = await pdcall("/record", { method: "POST", body: JSON.stringify({ cfg: encodeConfig({ ...LIST, k: code }), status: 200, lang: "ar" }) });
assert.equal(r.status, 204); assert.equal(dbRows.length, 2);
assert.equal(dbRows[1].row.access_email, "buyer@example.com"); assert.equal(dbRows[1].row.access_ref, "cs_test_new"); assert.equal(dbRows[1].row.master, false);
r = await worker.fetch(new Request(`${SELF}/record`, { method: "POST", body: JSON.stringify({ cfg: encodeConfig({ ...LIST, k: "master-key-for-tests" }), status: 200 }) }), { ...pdenv, MASTER_ACCESS_KEY: "master-key-for-tests" }, ctx);
assert.equal(dbRows[2].row.master, true); assert.equal(dbRows[2].row.access_email, null);

// access codes: tamper / expiry / foreign secret
assert.equal(await verifyAccess(penv, code.slice(0, -1) + (code.endsWith("0") ? "1" : "0")), null, "tampered mac");
assert.equal(await verifyAccess(penv, code, access.exp + 1), null, "expired");
assert.equal(await verifyAccess({ ...penv, PROXY_SECRET: "other" }, code), null, "other secret");
const valid = await mintAccess(penv, { email: "x@y", exp: Math.floor(Date.now() / 1000) + 3600, ref: "cs_x", src: listSrc });
const expired = await mintAccess(penv, { email: "x@y", exp: Math.floor(Date.now() / 1000) - 10, ref: "cs_x", src: listSrc });
const validExp = (await verifyAccess(penv, valid)).exp;
await assert.rejects(mintAccess(penv, { exp: validExp }), /src/, "codes cannot be minted unbound");

// source binding: same code, other playlist -> refused; get.php url and xtream login are one subscription
r = await pcall(linkPath({ u: "http://provider.test/other.m3u", k: valid }));
assert.equal(r.status, 402); assert.match(await r.text(), /different playlist/);
assert.equal((await pcall(linkPath({ ...LIST, k: valid, h: 1 }))).status, 200, "hls flag does not change the source");
const xtCfg = { x: ["provider.test", "usr", "pw"] };
const getphpCfg = { u: "http://provider.test/get.php?username=usr&password=pw&type=m3u_plus&output=ts" };
const xtSrc = await sourceHash(parseConfig(encodeConfig(xtCfg)));
assert.equal(await sourceHash(parseConfig(encodeConfig(getphpCfg))), xtSrc, "get.php url == xtream login");
assert.equal(await sourceHash(parseConfig(encodeConfig({ x: ["HTTP://PROVIDER.TEST", "usr", "pw"] }))), xtSrc, "host case-insensitive");
assert.notEqual(await sourceHash(parseConfig(encodeConfig({ x: ["provider.test", "usr", "PW"] }))), xtSrc, "password matters");
const xtCode = await mintAccess(penv, { exp: validExp, src: xtSrc });
r = await pcall(linkPath({ ...xtCfg, k: xtCode, h: 1 }));
assert.equal(r.status, 200, await r.clone().text());
assert.equal((await pcall(linkPath({ ...getphpCfg, k: xtCode }))).status, 200, "same code works for the get.php form");
assert.equal((await pcall(linkPath({ ...LIST, k: xtCode }))).status, 402);

// playlist with a valid code: streams carry exp= and a signature over host|exp
r = await pcall(linkPath({ u: "http://provider.test/list.m3u", k: valid, h: 1 }));
assert.equal(r.status, 200, await r.clone().text());
body = await r.text();
const pl = body.trim().split("\n");
assert.match(pl[2], new RegExp(`^https://relay\\.example/e/provider\\.test/live/u/p/1\\.m3u8\\?exp=${validExp}&sig=[0-9a-f]{32}$`));
assert.match(pl[6], new RegExp(`\\?token=abc&exp=${validExp}&sig=[0-9a-f]{32}$`));
// expired code -> refused
assert.equal((await pcall(linkPath({ u: "http://provider.test/list.m3u", k: expired }))).status, 402);

// relay under the paywall: manifest rewritten with the same exp; sig without exp, tampered exp, expired exp are refused
const streamUrl = pl[2].replace(SELF, "");
r = await pcall(streamUrl);
assert.equal(r.status, 200, await r.clone().text());
body = await r.text();
assert.match(body, new RegExp(`^https://relay\\.example/e/edge\\.test/hls/1/seg1\\.ts\\?exp=${validExp}&sig=[0-9a-f]{32}$`, "m"));
assert.match(body, new RegExp(`URI="https://relay\\.example/e/edge\\.test/hls/1/key\\.bin\\?exp=${validExp}&sig=`));
const segUrl = body.match(/^https:\/\/relay\.example(\/e\/edge\.test\/hls\/1\/seg1\.ts\?exp=\d+&sig=[0-9a-f]{32})$/m)[1];
assert.equal((await pcall(segUrl)).status, 200);
assert.equal((await pcall(segUrl.replace(`exp=${validExp}`, `exp=${validExp + 1}`))).status, 403, "exp is covered by the signature");
assert.equal((await pcall(streamUrl.replace(`exp=${validExp}&`, ""))).status, 403, "exp is required under the paywall");
assert.equal((await pcall(`/e/edge.test/hls/1/seg1.ts?sig=${edgeSig}`)).status, 403, "pre-paywall signatures stop working");
// master key: any playlist, no purchase; streams get a year-long exp; wrong/near-miss keys are refused
const menv = { ...penv, MASTER_ACCESS_KEY: "master-key-for-tests" };
const mcall = (path, init) => worker.fetch(new Request(`${SELF}${path}`, init), menv, ctx);
for (const cfg of [LIST, { u: "http://provider.test/list.m3u?another=1" }, xtCfg]) {
  r = await mcall(linkPath({ ...cfg, k: "master-key-for-tests" }));
  assert.equal(r.status, 200, await r.clone().text());
}
body = await (await mcall(linkPath({ ...LIST, k: "master-key-for-tests", h: 1 }))).text();
const mExp = Number(body.match(/\?exp=(\d+)&sig=/)[1]);
assert.ok(mExp > Date.now() / 1000 + 360 * 86400 && mExp < Date.now() / 1000 + 368 * 86400, "master exp is about a year out");
assert.equal((await mcall(body.trim().split("\n")[2].replace(SELF, ""))).status, 200, "master-signed streams relay");
assert.equal((await mcall(linkPath({ ...LIST, k: "master-key-for-test" }))).status, 402, "near miss");
assert.equal((await mcall(linkPath({ ...LIST, k: "MASTER-KEY-FOR-TESTS" }))).status, 402, "case matters");
assert.equal((await pcall(linkPath({ ...LIST, k: "master-key-for-tests" }))).status, 402, "no master key configured");
assert.equal((await worker.fetch(new Request(`${SELF}${linkPath({ ...LIST, k: "short" })}`), { ...penv, MASTER_ACCESS_KEY: "short" }, ctx)).status, 402, "keys under 8 chars are ignored");

// an exp in the past is refused even with a correct signature: use a code that is valid for 1s
const shortCode = await mintAccess(penv, { exp: Math.floor(Date.now() / 1000) + 1, src: listSrc });
const shortLine = (await (await pcall(linkPath({ u: "http://provider.test/list.m3u", k: shortCode }))).text()).trim().split("\n")[2];
await new Promise((res) => setTimeout(res, 1100));
assert.equal((await pcall(shortLine.replace(SELF, ""))).status, 403, "expired exp is refused even with a valid signature");

server.close();
console.log("ALL TESTS PASSED");
