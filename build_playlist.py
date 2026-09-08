#!/usr/bin/env python3
"""Build M3U+ playlists from Xtream Codes player_api JSON dumps."""
import json
import sys

HOST = "http://till41909.wd.business-cloud-4.ru"
USER = "8465c924abb6"
PASS = "8a59b9c145"

cats = {c["category_id"]: c["category_name"] for c in json.load(open("get_live_categories.json"))}
streams = json.load(open("get_live_streams.json"))
streams.sort(key=lambda s: s.get("num", 0))


def clean(s):
    return (s or "").replace('"', "'").replace("\n", " ").strip()


def build(ext, out_path):
    lines = ['#EXTM3U x-tvg-url=""']
    for s in streams:
        sid = s["stream_id"]
        name = clean(s.get("name"))
        group = clean(cats.get(str(s.get("category_id")), "Uncategorized"))
        logo = clean(s.get("stream_icon"))
        tvg_id = clean(s.get("epg_channel_id"))
        lines.append(
            f'#EXTINF:-1 tvg-id="{tvg_id}" tvg-name="{name}" tvg-logo="{logo}" group-title="{group}",{name}'
        )
        lines.append(f"{HOST}/live/{USER}/{PASS}/{sid}.{ext}")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"{out_path}: {len(streams)} channels, {len(cats)} groups", file=sys.stderr)


build("ts", "playlist.m3u")
build("m3u8", "playlist-hls.m3u")
