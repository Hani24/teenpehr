"""Article bodies for feeds that only give titles or short blurbs: robots.txt first, then the page,
then text extraction (trafilatura)."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import trafilatura

from .. import log
from .robots import AGENT, Robots

if TYPE_CHECKING:
    from .http import Fetcher, FetchResult

logger = log.get("fetch.article")

MAX_CHARS = 2000
MAX_CRAWL_WAIT_S = 10.0  # when a Crawl-delay would make us wait longer than this, skip the article
ROBOTS_MAX_BYTES = 512_000  # RFC 9309 asks crawlers to read at least 500 KiB


@dataclass
class Article:
    """An article page: its text (cut to `max_chars`) and the page's own metadata (decision D5).
    `status`, `ms` and `route` describe the page fetch; `words` counts the whole extracted text."""

    text: str = ""
    words: int = 0
    author: str | None = None
    site_name: str | None = None
    categories: list[str] = field(default_factory=list)
    image_url: str | None = None
    description: str | None = None
    date: str | None = None  # YYYY-MM-DD as the page states it
    language: str | None = None  # the page's declared language
    status: int = 0
    ms: int = 0
    route: str = "direct"

    def meta(self) -> dict[str, Any]:
        """The metadata as a small dict for an item's `raw` (empty values left out)."""
        keys = ("author", "site_name", "categories", "image_url", "description", "date", "language")
        return {k: getattr(self, k) for k in keys if getattr(self, k)}


def _cut(text: str, max_chars: int) -> str:
    text = " ".join(text.split())
    if len(text) > max_chars:
        cut = text[:max_chars]
        text = cut[: cut.rfind(" ")] + " …"
    return text


def _str(v: Any, limit: int) -> str | None:
    return " ".join(v.split())[:limit] or None if isinstance(v, str) else None


def extract_article(html: bytes | str, url: str | None = None, max_chars: int = MAX_CHARS) -> Article:
    """Text and metadata of an article page; an empty Article when nothing could be extracted."""
    if isinstance(html, bytes):
        html = html.decode("utf-8", "ignore")
    doc = trafilatura.bare_extraction(
        html,
        url=url,
        include_comments=False,
        include_tables=False,
        favor_precision=True,
        deduplicate=True,
        with_metadata=True,
    )
    if doc is None or not getattr(doc, "text", None):
        return Article()
    full = " ".join(doc.text.split())
    cats = [c.strip() for c in (doc.categories or []) + (doc.tags or []) if isinstance(c, str) and c.strip()]
    image = doc.image if isinstance(doc.image, str) and doc.image.startswith(("http://", "https://")) else None
    return Article(
        text=_cut(full, max_chars),
        words=len(full.split()),
        author=_str(doc.author, 300),
        site_name=_str(doc.sitename, 200),
        categories=list(dict.fromkeys(c[:100] for c in cats))[:30],
        image_url=image,
        description=_str(doc.description, 5000),
        date=_str(doc.date, 32),
        language=_str(doc.language, 16),
    )


def extract_text(html: bytes | str, url: str | None = None, max_chars: int = MAX_CHARS) -> str:
    return extract_article(html, url, max_chars).text


def _origin(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}".lower()


class ArticleFetcher:
    """Article text from pages the site's robots.txt allows, spaced by its Crawl-delay.

    robots.txt is read once per host and kept for this object's life, so make one per run. It is
    fetched on the article's route; a 4xx means no rules, while a 5xx, timeout or 429 means the
    host is off limits for the rest of the run."""

    def __init__(self, fetcher: Fetcher, *, agent: str = AGENT, max_wait_s: float = MAX_CRAWL_WAIT_S):
        self.fetcher = fetcher
        self.agent = agent
        self.max_wait_s = max_wait_s
        self._robots: dict[str, Robots] = {}
        self._last: dict[str, float] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock(self, origin: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(origin, threading.Lock())

    def _robots_for(self, origin: str, route: str) -> Robots:
        # caller holds self._lock(origin), so two threads never fetch one robots.txt twice
        if origin not in self._robots:
            res = self.fetcher.get(
                f"{origin}/robots.txt",
                route=route,
                headers={"Accept": "text/plain,*/*;q=0.8"},
                allow_fallback=False,
                max_bytes=ROBOTS_MAX_BYTES,
            )
            if res.ok:
                self._robots[origin] = Robots(res.content.decode("utf-8", "replace"))
            elif res.rate_limited or res.status == 0 or res.status >= 500:
                logger.info("%s/robots.txt unreachable (%s): no article pages from it this run", origin, res.error)
                self._robots[origin] = Robots.unreachable()
            else:
                self._robots[origin] = Robots()
        return self._robots[origin]

    def allowed(self, url: str, route: str = "direct") -> bool:
        """Whether robots.txt lets us fetch this page now (reads robots.txt on first use per host).
        False too while the host cools down after a 429, so a caller spends no budget on it."""
        left = getattr(self.fetcher, "cooldown_left", None)  # duck-typed test fetchers may not have it
        if left and left(url) > 0:
            return False
        origin = _origin(url)
        with self._lock(origin):
            return self._robots_for(origin, route).allowed(url, self.agent)

    def robots_verdict(self, url: str, route: str = "direct") -> str:
        """ "allowed", "disallowed" or "unreachable" (robots.txt could not be read, so nothing is
        allowed), whatever any 429 cooldown says; for reports such as the source audit."""
        origin = _origin(url)
        with self._lock(origin):
            robots = self._robots_for(origin, route)
        if robots.allow_nothing:
            return "unreachable"
        return "allowed" if robots.allowed(url, self.agent) else "disallowed"

    def fetch_text(self, url: str, *, route: str = "direct", max_chars: int = MAX_CHARS) -> str:
        """The page's article text, or "" when robots.txt disallows it, its Crawl-delay would stall
        the run, or the fetch or extraction fails."""
        art = self.fetch_article(url, route=route, max_chars=max_chars)
        return art.text if art else ""

    def fetch_page(self, url: str, *, route: str = "direct", **get: Any) -> FetchResult | None:
        """The page as fetched (robots.txt and Crawl-delay honoured); None when robots.txt disallows
        it or its Crawl-delay would stall the run, so nothing was fetched. `get` goes to Fetcher.get
        (a publisher image: its headers and hard size cap), spaced like the host's pages."""
        origin = _origin(url)
        with self._lock(origin):
            robots = self._robots_for(origin, route)
            if not robots.allowed(url, self.agent):
                logger.debug("robots.txt disallows %s", url)
                return None
            delay = robots.crawl_delay(self.agent) or 0.0
            last = self._last.get(origin)
            wait = last + delay - time.monotonic() if last is not None else 0.0
            if wait > self.max_wait_s:
                logger.debug("skipping %s: Crawl-delay %.0f s", url, delay)
                return None
            if wait > 0:
                time.sleep(wait)
            try:
                return self.fetcher.get(url, route=route, **{"allow_fallback": False, **get})
            finally:
                self._last[origin] = time.monotonic()

    def fetch_article(self, url: str, *, route: str = "direct", max_chars: int = MAX_CHARS) -> Article | None:
        """The page's text and metadata; None when robots.txt disallows it or its Crawl-delay would
        stall the run (nothing was fetched). A failed fetch or extraction is an Article with no text."""
        page = self.fetch_page(url, route=route)
        if page is None:
            return None
        how = {"status": page.status, "ms": page.ms, "route": page.route_used or route}
        if not page.ok:
            logger.debug("article fetch failed for %s: %s", url, page.error)
            return Article(**how)
        try:
            art = extract_article(page.content, url, max_chars)
        except Exception as e:  # noqa: BLE001 - trafilatura/lxml on hostile markup
            logger.debug("extraction failed for %s: %s", url, e)
            return Article(**how)
        art.status, art.ms, art.route = how["status"], how["ms"], how["route"]
        return art
