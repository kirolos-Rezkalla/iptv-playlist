# iptv-proxy (Cloudflare Worker)

A self-service HTTPS relay for HTTP-only IPTV playlists. Users open the worker's
landing page, paste their M3U URL (or Xtream Codes server + username +
password) and get back an HTTPS playlist link. Every plain-HTTP stream in that
playlist is rewritten to go through the worker, so players that refuse HTTP
(iOS apps such as rPlayTV) can load the list and play the channels.

The link itself carries the source, and the playlist is regenerated from the
provider on demand (cached for 5 minutes). With `DATABASE_URL` set, generated
links and purchases are also recorded in PostgreSQL (see Storage below).

## Routes

| Route | What it does |
|---|---|
| `/` | Landing page with the form. Builds the link client-side and does a quick fetch to confirm the playlist loads. |
| `/l/<cfg>/playlist.m3u` | The generated playlist. `<cfg>` is base64url JSON: `{"u":"<m3u url>"}` for an M3U source or `{"x":["<host>","<user>","<pass>"]}` for Xtream (built from `player_api.php`, same as `build_playlist.py`). Add `"h":1` to convert `.ts` stream URLs to `.m3u8`. If an M3U URL is a `get.php?username=…&password=…` link and the provider refuses it (some panels answer HTTP 884 with an empty body) or returns something that is not an M3U, the worker falls back to building the playlist from `player_api.php` with those credentials. |
| `/e/<host>/<path>?sig=…` | Relays `http://<host>/<path>`: follows the provider's 302 to its edge servers, rewrites `.m3u8` bodies so segments and keys also go through the worker, streams everything else through untouched. |
| `/playlist.m3u`, `/playlist-hls.m3u` | Legacy: 302 to the generated link for `PLAYLIST_BASE + name`, if `PLAYLIST_BASE` is set. |

`sig` is an HMAC (keyed by `PROXY_SECRET`) over the upstream *host*. Only hosts
that appeared in a generated playlist or HLS manifest get a signature, so `/e/`
cannot be pointed at arbitrary URLs by hand. It does mean anyone can relay any
HTTP host by first putting it in an M3U somewhere; if you run this publicly,
treat it as such (Cloudflare's WAF / rate limiting rules are the place to add
protection). Private and loopback addresses are refused.

## Deploy

A free Cloudflare account is enough.

```sh
cd worker
npx -y wrangler@latest login                      # opens a browser once
npx -y wrangler@latest secret put PROXY_SECRET    # paste any long random string
npx -y wrangler@latest deploy
```

Deploy prints a URL like `https://iptv-proxy.<you>.workers.dev`. Open it, fill
in the form, copy the link into your player.

Run locally: create `worker/.dev.vars` containing `PROXY_SECRET=anything`, then
`npx -y wrangler@latest dev` and open http://127.0.0.1:8787/.

## Charging for access (Stripe)

Off by default. When on, `/l/` links must carry an access code (`"k"` in the
link config) and every relayed stream URL carries the code's expiry, covered by
the signature, so playback stops when access lapses. Codes are stateless
(signed payload of email, expiry, Stripe session id and a hash of the playlist
source); nothing is stored.

**One code, one playlist.** The buyer enters their M3U URL or Xtream login
first; `POST /buy` receives it as form field `cfg`, sends only its hash to
Stripe as session metadata, and creates a Checkout Session (one-time payment).
Stripe sends the customer back to `/welcome?session_id=…`, where the worker
verifies the session, mints a code carrying that hash (valid `ACCESS_DAYS` from
the session's creation) and, if the playlist details are still in the browser,
shows the finished playlist link. `/l/` refuses a code whose hash does not match
the link's source, so a shared code is useless for anyone else's subscription.
A `get.php?username=…&password=…` URL and the Xtream login with the same
credentials hash the same. Revisiting the welcome page shows the same code. No
webhook or database needed.

Setup:

1. In Stripe, create a Product with a one-time Price and copy its `price_…` id.
2. `npx wrangler secret put STRIPE_SECRET_KEY` (use `sk_test_…` first).
3. In `wrangler.toml`: `STRIPE_PRICE_ID = "price_…"`, `ACCESS_DAYS = "30"`, then `PAYWALL = "1"`.
4. `npx wrangler deploy`. Test with card `4242 4242 4242 4242` in test mode, then swap to the live key.

For your own use, set a master code: `npx wrangler secret put MASTER_ACCESS_KEY`
(a long random string, at least 8 characters or it is ignored). Entered as the
access code, it works for any playlist, never expires, and skips payment. It
ends up inside your playlist links, so treat it like a password.

To give someone else access without a payment, mint a code locally:

```sh
cd worker && CFG='{"x":["http://provider.example","user","pass"]}' node -e '
import("./src/index.js").then(async m => {
  const src = await m.sourceHash(m.parseConfig(m.encodeConfig(JSON.parse(process.env.CFG))));
  console.log(await m.mintAccess({PROXY_SECRET: process.env.S}, {email: "x@y", exp: Math.floor(Date.now()/1000) + 30*86400, ref: "manual", src}));
})'
```

with `S` set to the deployed `PROXY_SECRET`. Refunds do not revoke codes
(there is no store to revoke against); the code simply expires.

Note Stripe's terms: its restricted-business list includes streaming of
content without a licence. Read it before going live.

## Storage (DigitalOcean PostgreSQL)

Optional. With the `HYPERDRIVE` binding configured, two tables in the `iptv`
database receive:

- `submissions`: one row each time someone generates a link on the front page
  (the entered M3U URL or Xtream host/username/password, the HLS option, the
  source hash, the owner of the access code used, whether the master key was
  used, the HTTP status of the playlist check, language, IP, country, user
  agent). The front page posts to `/record` after its check; playlist
  re-fetches by players are not recorded.
- `purchases`: one row per paid Stripe Checkout Session, written when the
  welcome page mints the code. Unique on the session id.

Writes are best-effort and run after the response; a database outage never
blocks a playlist. Setup, with the cluster credentials in the repo-root `.env`
(`username`, `password`, `host`, `port`, `database`, `sslmode`):

```sh
cd worker
node db/setup.mjs                                   # creates the database if missing, applies db/schema.sql
npx wrangler hyperdrive create iptv-db --connection-string="$(node db/url.mjs)"
#   -> copy the printed id into wrangler.toml under [[hyperdrive]] (binding "HYPERDRIVE"), deploy
node db/query.mjs "SELECT created_at, kind, result_status FROM submissions ORDER BY 1 DESC LIMIT 20"
```

Why Hyperdrive: Workers verify TLS certificates against public CAs only, and
DigitalOcean's managed databases use a private CA, so a direct connection from
the worker fails. Hyperdrive connects with `sslmode=require` and pools. The
client is node-postgres (`pg`) under the `nodejs_compat` flag. A `DATABASE_URL`
secret is honoured as a fallback but only works outside Workers (the `db/*.mjs`
scripts). Rows include users' provider passwords in plain text: restrict who can
read the database accordingly.

## Limits

- **Provider connection limit still applies.** The worker makes one upstream
  connection per stream being played; it does not multiplex.
- **Requests.** Workers free tier allows 100k requests/day. HLS uses roughly one
  request per segment (~every 10 s per viewer); MPEG-TS is one long request.
- **CPU.** Rewriting a playlist costs roughly 1.5 ms per 1,000 channels.
  The free tier's 10 ms CPU limit comfortably covers a few thousand channels;
  a 16k-channel list like the one in this repo needs the Workers Paid plan
  (30 ms default, raise with `[limits] cpu_ms` in `wrangler.toml`). Generated
  playlists are cached for 5 minutes, so this cost is paid once per link per
  5 minutes, not per player refresh.
- **Privacy.** The generated link contains the user's playlist URL or Xtream
  login. Treat links like passwords.

## Test

```sh
cd worker && npm test
```

`test.mjs` runs the worker in plain Node (no dependencies) against a fake
provider: playlist generation from an M3U URL and from Xtream credentials, the
`.ts` -> `.m3u8` option, caching, HLS manifest rewriting through a provider 302,
binary pass-through, signature checks and private-host rejection.
