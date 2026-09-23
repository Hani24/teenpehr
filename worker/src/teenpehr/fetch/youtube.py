"""YouTube channel Atom feeds (https://www.youtube.com/feeds/videos.xml?channel_id=...)."""

from __future__ import annotations

from .rss import Entry, parse_feed


def parse_channel_feed(data: bytes) -> list[Entry]:
    """Same shape as an RSS entry; the summary is the video description when present."""
    return [e for e in parse_feed(data) if "youtube.com/watch" in e.link or "youtu.be/" in e.link]
