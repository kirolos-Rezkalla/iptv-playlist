# iptv-playlist

HTTPS-hosted copy of a provider IPTV playlist, for use in rPlayTV (iOS).

| File | Stream format | URL to paste into the app |
|---|---|---|
| `playlist.m3u` | MPEG-TS (`.ts`) | https://raw.githubusercontent.com/kirolos-Rezkalla/iptv-playlist/main/playlist.m3u |
| `playlist-hls.m3u` | HLS (`.m3u8`) | https://raw.githubusercontent.com/kirolos-Rezkalla/iptv-playlist/main/playlist-hls.m3u |

The provider's `get.php` M3U endpoint returns an empty HTTP 884 response for this
line, so the playlists here are generated from the Xtream Codes `player_api.php`
(live categories + live streams) by `build_playlist.py`.

To refresh:

```sh
H="http://till41909.wd.business-cloud-4.ru"; C="username=8465c924abb6&password=8a59b9c145"
curl -sS "$H/player_api.php?$C&action=get_live_categories" -o get_live_categories.json
curl -sS "$H/player_api.php?$C&action=get_live_streams"    -o get_live_streams.json
python3 build_playlist.py
```

Note: the channel stream URLs themselves are plain HTTP (the provider has no
HTTPS port). Only the playlist file is served over HTTPS.
