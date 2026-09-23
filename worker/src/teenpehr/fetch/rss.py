"""RSS 2.0 / Atom / RDF parsing with feedparser, tolerant of lying charset headers and odd dates."""

from __future__ import annotations

import calendar
import html as htmllib
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urljoin

import feedparser
from dateutil import parser as dtparser

from .. import log

logger = log.get("fetch.rss")

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


@dataclass
class Entry:
    title: str
    link: str
    summary: str
    published: datetime | None


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
        entries.append(Entry(title=title, link=link, summary=summary, published=published))
    return entries
