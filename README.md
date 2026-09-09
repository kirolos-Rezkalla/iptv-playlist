# iptv-playlist

Tools for using an HTTP-only IPTV subscription in players that require HTTPS
(e.g. rPlayTV on iOS).

## The service: `worker/`

A Cloudflare Worker that turns any plain-HTTP IPTV playlist into an HTTPS link.
Live at **https://iptv-proxy.stream-relay.workers.dev/**.
Open the worker's page, paste an M3U URL (or Xtream Codes server, username and
password), tick "convert to HLS" for iOS, and copy the generated link into the
player. The worker serves the playlist over HTTPS and relays the streams
through itself, so both the channel list and playback work.

See [`worker/README.md`](worker/README.md) for routes, deployment (a free
Cloudflare account is enough) and limits.

## Static playlists (original, single-provider setup)

Before the worker became self-service, this repo hosted one provider's playlist
on GitHub so it would be reachable over HTTPS:

| File | Stream format | URL to paste into the app |
|---|---|---|
| `playlist.m3u` | MPEG-TS (`.ts`) | https://raw.githubusercontent.com/kirolos-Rezkalla/iptv-playlist/main/playlist.m3u |
| `playlist-hls.m3u` | HLS (`.m3u8`) | https://raw.githubusercontent.com/kirolos-Rezkalla/iptv-playlist/main/playlist-hls.m3u |

The provider's `get.php` M3U endpoint returns an empty response for this line,
so the playlists are generated from the Xtream Codes `player_api.php` by
`build_playlist.py` (the worker's "Xtream login" mode does the same thing on
the fly). To refresh them:

```sh
H="http://<provider host>"; C="username=<user>&password=<pass>"
curl -sS "$H/player_api.php?$C&action=get_live_categories" -o get_live_categories.json
curl -sS "$H/player_api.php?$C&action=get_live_streams"    -o get_live_streams.json
python3 build_playlist.py
```

Only the playlist file is served over HTTPS this way; the channel URLs inside
are still plain HTTP. If the worker's `PLAYLIST_BASE` points here, its old
`/playlist.m3u` and `/playlist-hls.m3u` routes redirect to generated links for
these files.
