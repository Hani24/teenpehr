"""Google News sitemaps (source kind `sitemap`, decision D11).

A publisher's news sitemap lists what it published in the last two days: each `<url>` has the
article's `<loc>` and a `<news:news>` block with the headline, the publication date, the
publication's name and language, and often keywords and an image (`<image:image>`). It is the
publisher's own machine-readable list for crawlers, so it is fetched only where the site's
robots.txt allows the sitemap's path (the collector checks; feeds are fetched as feeds).

Some sitemaps are an index (`<sitemapindex>`) of dated child sitemaps; the newest one or two are
read. Only the publisher's own site counts (`site_of`): a child sitemap or an article on another site is
dropped by the reader (fetch/kinds.py), as search engines ignore cross-site sitemap entries, so a source
never cites another outlet's page under its own name. Sitemaps carry no summary, so the collector
fetches a short article body for these items the way it does for Google News items (robots.txt,
Crawl-delay, the per-run article budget).

Parsing is incremental (`XMLPullParser`) with the standard library's expat, which neither
fetches external entities nor expands entity bombs; a truncated or malformed file keeps the
entries parsed before the fault. Everything in a sitemap is untrusted data."""

from __future__ import annotations

import gzip
import io
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin, urlsplit

from .. import log
from .rss import RAW_STR_MAX, Entry, parse_date, strip_html

logger = log.get("fetch.sitemap")

MAX_GUNZIP_BYTES = 20_000_000  # a .xml.gz sitemap is unpacked up to this, never further (zip bomb guard)
MAX_ENTRIES = 2000  # Google's own limit for a news sitemap is 1,000 URLs
INDEX_CHILDREN = 2  # child sitemaps read from an index: the newest ones
_WS_RE = re.compile(r"\s+")


@dataclass
class Sitemap:
    """A parsed sitemap: its news entries (newest first) or, for an index, its child sitemaps
    (newest first when they carry `<lastmod>`, else in the order listed)."""

    entries: list[Entry] = field(default_factory=list)
    children: list[str] = field(default_factory=list)
    is_index: bool = False
    truncated: bool = False  # the XML ended early or broke; `entries` holds what came before


def _local(tag: Any) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _text(el: ET.Element | None) -> str:
    return _WS_RE.sub(" ", strip_html(el.text or "")).strip() if el is not None and el.text else ""


def _child(el: ET.Element, *path: str) -> ET.Element | None:
    """The first descendant along `path` of local tag names, namespaces ignored (sitemaps in the
    wild use several namespace URIs for the same news and image elements)."""
    cur: ET.Element | None = el
    for name in path:
        if cur is None:
            return None
        cur = next((c for c in cur if _local(c.tag) == name), None)
    return cur


def _http(url: str, base: str) -> str | None:
    u = url.strip()
    if not u:
        return None
    u = urljoin(base, u) if base else u
    return u if u.startswith(("http://", "https://")) else None


# Generic second levels under a two-letter country code (com.pk, co.uk, gov.in, org.af, ac.bd...).
_CC_SECOND_LEVELS = frozenset(
    {"ac", "co", "com", "edu", "go", "gob", "gov", "mil", "ne", "net", "nic", "or", "org", "res"}
)


def site_of(url: str) -> str:
    """The site a URL belongs to: its host cut to the registrable name (the last two labels, or three
    under a country code's generic second level such as com.pk or co.uk), so www.dawn.com, epaper.dawn.com
    and dawn.com are one site. An approximation of the public suffix list, enough to tell a publisher's
    own pages from anyone else's."""
    host = (urlsplit(url).hostname or "").lower().rstrip(".")
    labels = [x for x in host.split(".") if x]
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in _CC_SECOND_LEVELS:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def unpack(data: bytes) -> bytes:
    """A gzipped sitemap (served as a file, so not undone by Content-Encoding) unpacked, capped."""
    if not data.startswith(b"\x1f\x8b"):
        return data
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as gz:
            return gz.read(MAX_GUNZIP_BYTES)
    except (OSError, EOFError) as e:
        logger.debug("gzip sitemap unreadable: %s", e)
        return b""


def _entry(url_el: ET.Element, base: str) -> Entry | None:
    link = _http(_text(_child(url_el, "loc")), base)
    news = _child(url_el, "news")
    if not link or news is None:
        return None  # a plain (non-news) sitemap entry has no headline, and a headline is never made up
    title = _text(_child(news, "title"))
    if not title:
        return None
    pub_name = _text(_child(news, "publication", "name")) or None
    pub_lang = _text(_child(news, "publication", "language")) or None
    pub_date = _text(_child(news, "publication_date")) or None
    lastmod = _text(_child(url_el, "lastmod")) or None
    keywords = _text(_child(news, "keywords"))
    cats = [k.strip() for k in keywords.split(",") if k.strip()] if keywords else []
    image = None
    img_el = _child(url_el, "image", "loc")
    if img_el is not None:
        image = _http(_text(img_el), link)
    raw: dict[str, Any] = {
        "loc": link,
        "lastmod": lastmod,
        "news": {
            k: v[:RAW_STR_MAX]
            for k, v in {
                "name": pub_name,
                "language": pub_lang,
                "publication_date": pub_date,
                "keywords": keywords or None,
                "genres": _text(_child(news, "genres")) or None,
                "stock_tickers": _text(_child(news, "stock_tickers")) or None,
            }.items()
            if v
        },
        "image": image,
    }
    return Entry(
        title=title,
        link=link,
        summary="",
        published=parse_date(pub_date) or parse_date(lastmod),
        categories=list(dict.fromkeys(c[:100] for c in cats))[:30],
        image_url=image,
        updated=parse_date(lastmod) if lastmod else None,
        feed_title=pub_name,
        source_name=pub_name,
        raw={k: v for k, v in raw.items() if v not in (None, "", {})},
    )


def parse_sitemap(data: bytes, base_url: str = "") -> Sitemap:
    """Entries of a news sitemap, or the child sitemaps of an index. Never raises on bad input."""
    out = Sitemap()
    body = unpack(data)
    if not body.strip():
        return out
    parser = ET.XMLPullParser(events=("start", "end"))
    kids: list[tuple[datetime | None, int, str]] = []
    parser.feed(body)  # a syntax error is queued as an event, raised by read_events() in its place
    try:
        parser.close()
    except ET.ParseError as e:  # the document ended early (a body cut at the size cap)
        out.truncated = True
        logger.debug("sitemap ended early: %s", e)
    try:
        for event, el in parser.read_events():
            name = _local(el.tag)
            if event == "start":
                if name == "sitemapindex":
                    out.is_index = True
                continue
            if name == "url" and len(out.entries) < MAX_ENTRIES:
                en = _entry(el, base_url)
                if en is not None:
                    out.entries.append(en)
                el.clear()
            elif name == "sitemap":
                loc = _http(_text(_child(el, "loc")), base_url)
                if loc:
                    kids.append((parse_date(_text(_child(el, "lastmod")) or None), len(kids), loc))
                el.clear()
    except ET.ParseError as e:  # malformed XML: keep the entries read before the fault
        out.truncated = True
        logger.debug("sitemap parse stopped: %s", e)
    oldest = datetime.min.replace(tzinfo=UTC)
    # Newest first; undated last, in the order the file lists them.
    out.entries.sort(key=lambda e: e.published or oldest, reverse=True)
    if any(d for d, _, _ in kids):
        kids.sort(key=lambda k: (k[0] or oldest, -k[1]), reverse=True)
    out.children = list(dict.fromkeys(loc for _, _, loc in kids))
    return out
