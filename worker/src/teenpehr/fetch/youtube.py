"""YouTube channel Atom feeds (https://www.youtube.com/feeds/videos.xml?channel_id=...)."""

from __future__ import annotations

import re

from .rss import Entry, parse_feed

_VIDEO_RE = re.compile(
    r"^https?://(?:(?:www|m)\.)?(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|live/)|youtu\.be/)([A-Za-z0-9_-]+)"
)


def watch_url(link: str) -> str | None:
    """The watch?v= form of a video, Short, live or youtu.be link; None for anything else."""
    m = _VIDEO_RE.match(link.strip())
    return f"https://www.youtube.com/watch?v={m.group(1)}" if m else None


def parse_channel_feed(data: bytes) -> list[Entry]:
    """Same shape as an RSS entry; the summary is the video description when present. Every video
    link (Shorts included) is rewritten to watch?v=<id>, so one video has one URL."""
    entries: list[Entry] = []
    for e in parse_feed(data):
        url = watch_url(e.link)
        if url:
            e.link = url
            entries.append(e)
    return entries
