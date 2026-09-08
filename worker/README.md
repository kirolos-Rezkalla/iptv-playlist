# iptv-proxy (Cloudflare Worker) - fallback if HTTP channel playback fails

The playlists in this repo are served over HTTPS by GitHub, but every channel
URL inside them is plain HTTP (the provider has no HTTPS port at all). If the
player loads the channel list but refuses to play HTTP streams, deploy this
worker: it serves the playlist AND relays the streams over HTTPS.

Routes:

- `/playlist.m3u`, `/playlist-hls.m3u` - the GitHub playlists with every stream
  URL rewritten to `https://<worker>/p/...`
- `/p/<path>` - relays `http://<PROVIDER_HOST>/<path>`, follows the provider's
  302 to its edge servers, streams `.ts` through untouched and rewrites `.m3u8`
  bodies so segments also go through the worker
- `/e/<host>/<path>?sig=...` - relays a segment from an edge host; only URLs the
  worker itself signed (HMAC) are accepted, so it is not an open proxy

Deploy (free Cloudflare account is enough):

```sh
cd worker
npx -y wrangler@latest login          # opens a browser once
npx -y wrangler@latest secret put PROXY_SECRET   # any random string; then delete PROXY_SECRET from wrangler.toml
npx -y wrangler@latest deploy
```

The deploy prints a URL like `https://iptv-proxy.<you>.workers.dev`. Paste
`https://iptv-proxy.<you>.workers.dev/playlist-hls.m3u` (HLS, best for iOS) or
`.../playlist.m3u` (MPEG-TS) into rPlayTV.

Test locally without deploying: `npx -y wrangler@latest dev` then open
`http://127.0.0.1:8787/playlist-hls.m3u`.

Notes: the worker relays all video bytes, so the provider's 1-connection limit
still applies (the worker makes one upstream connection per playing stream).
Workers free tier allows 100k requests/day; HLS uses roughly one request per
10-second segment.
