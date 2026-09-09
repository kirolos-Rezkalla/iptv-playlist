# iptv-proxy (Cloudflare Worker)

A self-service HTTPS relay for HTTP-only IPTV playlists. Users open the worker's
landing page, paste their M3U URL (or Xtream Codes server + username +
password) and get back an HTTPS playlist link. Every plain-HTTP stream in that
playlist is rewritten to go through the worker, so players that refuse HTTP
(iOS apps such as rPlayTV) can load the list and play the channels.

Nothing is stored server-side: the link itself carries the source, and the
playlist is regenerated from the provider on demand (cached for 5 minutes).

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
