"""The GDELT DOC 2.0 API as a discovery source (source kind `gdelt`, decision D11).

`https://api.gdeltproject.org/api/v2/doc/doc?query=…&mode=artlist&format=json` lists articles
GDELT's crawler saw worldwide, about 15 minutes behind, with each article's URL, title, domain,
language, source country and social image. It is free and keyless on one condition: at most one
request every five seconds per client. Every request here goes through one process-wide pace,
and a 429 (GDELT's way of saying "slow down") puts the host on the Fetcher's cooldown like any
other. A source's `url` is the full API URL, so an editor can read it; `format=rss` works too.

GDELT answers some bad queries with HTTP 200 and a line of plain text ("Your search contained a
phrase that was too short…"); that is reported as an error, never parsed as entries. Titles and
domains are untrusted data like any feed's."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode, urlsplit

from .. import log
from .rss import RAW_STR_MAX, Entry, parse_feed, strip_html

logger = log.get("fetch.gdelt")

API_HOST = "api.gdeltproject.org"
API_URL = f"https://{API_HOST}/api/v2/doc/doc"
SPACING_S = 5.5  # GDELT asks for at most one request every 5 s; a little margin for clock jitter
MAX_RECORDS = 250  # the API's own maximum per request

_slot_lock = threading.Lock()
_last_end = float("-inf")


class GdeltError(ValueError):
    """GDELT answered, but not with a list of articles (a query error in plain text, bad JSON)."""


@contextmanager
def slot(spacing_s: float | None = None) -> Iterator[None]:
    """One GDELT request at a time for the whole process, each starting at least `spacing_s`
    (default SPACING_S) after the previous one ended, robots.txt included. Hold it around exactly
    one request."""
    global _last_end
    spacing = SPACING_S if spacing_s is None else spacing_s
    with _slot_lock:
        wait = _last_end + spacing - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            yield
        finally:
            _last_end = time.monotonic()


def is_gdelt(url: str) -> bool:
    return (urlsplit(url).hostname or "").lower() == API_HOST


def api_url(query: str, *, timespan: str = "1d", maxrecords: int = 75, sort: str = "datedesc") -> str:
    """The artlist URL for `query` (GDELT's own syntax: phrases, OR in parentheses, `domain:`,
    `sourcecountry:`, `sourcelang:`, `theme:`)."""
    params = {
        "query": query,
        "mode": "artlist",
        "format": "json",
        "timespan": timespan,
        "maxrecords": str(max(1, min(maxrecords, MAX_RECORDS))),
        "sort": sort,
    }
    return f"{API_URL}?{urlencode(params)}"


def parse_seendate(value: Any) -> datetime | None:
    """'20260929T031500Z' → aware datetime."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value.strip(), "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None


def _http(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip().startswith(("http://", "https://")) else None


def _clip(v: Any) -> Any:
    return v[:RAW_STR_MAX] if isinstance(v, str) else v


def parse_artlist(data: bytes) -> list[Entry]:
    """Entries of an artlist answer (JSON, or RSS when the URL asked for `format=rss`), newest
    first. Raises GdeltError for GDELT's plain-text error lines and unreadable JSON."""
    text = data.decode("utf-8", "replace").lstrip("﻿").strip()
    if not text:
        return []  # an artlist with no match comes back empty
    if text.startswith("<"):
        return parse_feed(data)
    if not text.startswith("{"):
        raise GdeltError(f"GDELT said: {' '.join(text.split())[:160]}")
    try:
        doc = json.loads(text, strict=False)  # GDELT titles sometimes carry raw control characters
    except ValueError as e:
        raise GdeltError(f"unreadable GDELT JSON: {e}") from e
    arts = doc.get("articles") if isinstance(doc, dict) else None
    if arts is None:
        return []
    if not isinstance(arts, list):
        raise GdeltError("GDELT JSON without an article list")
    entries: list[Entry] = []
    for a in arts:
        if not isinstance(a, dict):
            continue
        link = _http(a.get("url"))
        title = strip_html(a.get("title")) if isinstance(a.get("title"), str) else ""
        if not link or not title:
            continue
        seen = parse_seendate(a.get("seendate"))
        domain = a.get("domain") if isinstance(a.get("domain"), str) else None
        raw = {
            "domain": domain,
            "language": a.get("language"),
            "sourcecountry": a.get("sourcecountry"),
            "seendate": a.get("seendate"),
            "url_mobile": _http(a.get("url_mobile")),
            "socialimage": _http(a.get("socialimage")),
        }
        entries.append(
            Entry(
                title=title,
                link=link,
                summary="",
                published=seen,  # when GDELT saw it: the closest to a publication time it gives
                image_url=_http(a.get("socialimage")),
                source_name=domain,
                raw={k: _clip(v) for k, v in raw.items() if v not in (None, "")},
            )
        )
    oldest = datetime.min.replace(tzinfo=UTC)
    entries.sort(key=lambda e: e.published or oldest, reverse=True)
    return entries
