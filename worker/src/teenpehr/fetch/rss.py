"""RSS 2.0 / Atom / RDF parsing with feedparser, tolerant of lying charset headers and odd dates."""

from __future__ import annotations

import calendar
import html as htmllib
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin

import feedparser
from dateutil import parser as dtparser

from .. import log

logger = log.get("fetch.rss")

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_IMG_RE = re.compile(r"<img\b[^>]*?\bsrc\s*=\s*[\"']([^\"'>\s]+)", re.I)
RAW_STR_MAX = 500  # each string kept in Entry.raw; the API drops a raw subset over 16 KB


@dataclass
class Entry:
    """One feed entry. `summary` is the best text the feed gives (full content when present); the
    rest is research metadata (decision D5): the feed's own description, author, categories, lead
    image, guid, update time, and `raw`, a small capped subset of the entry as the feed sent it."""

    title: str
    link: str
    summary: str
    published: datetime | None
    author: str | None = None
    categories: list[str] = field(default_factory=list)
    image_url: str | None = None
    description: str | None = None
    guid: str | None = None
    updated: datetime | None = None
    feed_title: str | None = None  # the feed's own <title>
    source_name: str | None = None  # the entry's <source> (Google News: the publishing outlet)
    raw: dict[str, Any] = field(default_factory=dict)


def strip_html(text: str | None) -> str:
    if not text:
        return ""
    return _WS_RE.sub(" ", htmllib.unescape(_TAG_RE.sub(" ", text))).strip()


def parse_date(value: str | None, struct=None) -> datetime | None:
    """Prefer feedparser's parsed struct; fall back to dateutil for two-digit years and prose dates."""
    if struct is not None:
        try:
            return datetime.fromtimestamp(calendar.timegm(struct), tz=UTC)
        except (OverflowError, ValueError):
            pass
    if not value:
        return None
    try:
        d = dtparser.parse(value.strip(), fuzzy=True)
    except (ValueError, OverflowError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def _decode(data: bytes) -> str | bytes:
    """Geo and The News declare ISO-8859-1 while sending UTF-8; a clean UTF-8 decode wins."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data


def _http(url: Any, base: str) -> str | None:
    if not isinstance(url, str) or not url.strip():
        return None
    u = urljoin(base, url.strip()) if base else url.strip()
    return u if u.startswith(("http://", "https://")) else None


def _image(e: Any, base: str) -> str | None:
    """The entry's lead image: media:content or media:thumbnail, an image enclosure, else the first
    <img> in its HTML."""
    for m in e.get("media_content") or []:
        if (m.get("medium") == "image" or str(m.get("type", "")).startswith("image/")) and _http(m.get("url"), base):
            return _http(m.get("url"), base)
    for m in e.get("media_thumbnail") or []:
        if _http(m.get("url"), base):
            return _http(m.get("url"), base)
    for lk in (e.get("enclosures") or []) + [x for x in e.get("links") or [] if x.get("rel") == "enclosure"]:
        if str(lk.get("type", "")).startswith("image/") and _http(lk.get("href") or lk.get("url"), base):
            return _http(lk.get("href") or lk.get("url"), base)
    for html in [c.get("value") for c in e.get("content") or []] + [e.get("summary")]:
        m = _IMG_RE.search(html or "")
        if m and _http(htmllib.unescape(m.group(1)), base):
            return _http(htmllib.unescape(m.group(1)), base)
    return None


def _clip(v: Any) -> Any:
    return v[:RAW_STR_MAX] if isinstance(v, str) else v


def _own(e: Any, key: str) -> Any:
    """The entry's own value: feedparser 6 answers `updated` with `published` when the feed has none."""
    return dict.get(e, key)


def _raw(e: Any) -> dict[str, Any]:
    """A small subset of the entry for later research: the feed's own strings, capped, no bodies."""
    src = e.get("source") or {}
    raw: dict[str, Any] = {
        "id": e.get("id"),
        "link": e.get("link"),
        "title": e.get("title"),
        "published": e.get("published"),
        "updated": _own(e, "updated"),
        "author": e.get("author"),
        "tags": [t.get("term") for t in e.get("tags") or [] if t.get("term")][:30],
        "media": [m.get("url") for m in (e.get("media_content") or []) + (e.get("media_thumbnail") or [])][:5],
        "source": {"title": src.get("title"), "href": src.get("href")} if src else None,
        "comments": e.get("comments"),
        "yt_videoid": e.get("yt_videoid"),
        "views": (e.get("media_statistics") or {}).get("views"),
    }
    kept = {k: v for k, v in raw.items() if v not in (None, [], "")}
    return {k: [_clip(x) for x in v] if isinstance(v, list) else _clip(v) for k, v in kept.items()}


def parse_feed(data: bytes, feed_url: str = "") -> list[Entry]:
    parsed = feedparser.parse(_decode(data))
    if parsed.get("bozo") and not parsed.entries:
        exc = parsed.get("bozo_exception")
        logger.debug("feed parse problem: %s", exc)
    entries: list[Entry] = []
    for e in parsed.entries:
        title = strip_html(e.get("title"))
        if not title:
            continue
        link = e.get("link") or ""
        if not link:
            for lk in e.get("links", []):
                if lk.get("href"):
                    link = lk["href"]
                    break
        if not link:
            guid = e.get("id") or ""
            link = guid if guid.startswith("http") else ""
        if link and not link.startswith(("http://", "https://")):
            base = getattr(parsed.feed, "link", None) or feed_url or ""
            link = urljoin(base, link) if base else ""
        summary = ""
        content = e.get("content")
        if content:
            summary = strip_html(content[0].get("value"))
        if not summary:
            summary = strip_html(e.get("summary") or e.get("description"))
        published = parse_date(
            e.get("published") or e.get("updated") or e.get("created"),
            e.get("published_parsed") or e.get("updated_parsed"),
        )
        updated = parse_date(_own(e, "updated"), _own(e, "updated_parsed")) if _own(e, "updated") else None
        author = strip_html(e.get("author") or (e.get("author_detail") or {}).get("name")) or None
        tags = [strip_html(t.get("term") or t.get("label")) for t in e.get("tags") or []]
        source = e.get("source") or {}
        entries.append(
            Entry(
                title=title,
                link=link,
                summary=summary,
                published=published,
                author=author,
                categories=list(dict.fromkeys(t for t in tags if t))[:30],
                image_url=_image(e, link or feed_url),
                description=strip_html(e.get("summary") or e.get("description")) or None,
                guid=(e.get("id") or "").strip() or None,
                updated=updated,
                feed_title=strip_html(getattr(parsed.feed, "title", "") or "") or None,
                source_name=strip_html(source.get("title")) or None,
                raw=_raw(e),
            )
        )
    return entries
