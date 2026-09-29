"""The full text of one cited article, for a reader-requested Urdu translation (decision D9), fetched
within every rule the edition run keeps, or a plain reason why it cannot be had.

Etiquette. robots.txt first, for our product token (`teenpehr`) and for `Claude-User`, the token for a
fetch a person asks an AI to make: either one disallowing the page is a no. Its Crawl-delay spaces our
requests to that host. Every redirect hop is checked the same way before it is followed (robots.txt of
the new host, public addresses only), and a hop to a sign-in or subscription page ends there. The
Fetcher keeps one request per host at a time and the shared 429 cooldowns. The source's route is used;
a host unreachable directly is tried through Germany, for reach only, and with the Germany route down
that is `needs_germany`. Nothing escalates: no stealth browser, no other fingerprint, no cookies, no
archive or cache copies, no second try after a 403.

Paywalls are never bypassed. A page whose publisher marks it as not free (schema.org
`isAccessibleForFree: false`, `article:content_tier` locked or metered), a 401 or 402, a redirect to a
sign-in or subscription page, or a short text next to subscription prompts is `paywalled`, even when the
HTML happens to carry more text. A page that opts out of AI use (`noai` in its robots meta tag or its
X-Robots-Tag header) is `robots_disallowed`.

Everything fetched here is untrusted data: it only ever reaches Claude quoted as text to translate."""

from __future__ import annotations

import contextlib
import hashlib
import json
import re
import socket
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urljoin, urlsplit

import trafilatura
from lxml import html as lxml_html

from .. import log
from ..fetch.robots import AGENT, Robots
from ..normalize import detect_lang

if TYPE_CHECKING:
    from ..config import Settings
    from ..fetch.http import Fetcher, FetchResult
    from ..models import TranslationBlockReason

logger = log.get("jobs.fulltext")

MAX_PAGE_BYTES = 5_000_000
ROBOTS_MAX_BYTES = 512_000  # RFC 9309 asks crawlers to read at least 500 KiB
ROBOTS_TTL_S = 6 * 3600.0  # the runner is long-lived: read a host's robots.txt again after this
MAX_HOPS = 5
MAX_CRAWL_WAIT_S = 60.0  # a longer Crawl-delay wait makes the job try again later instead of sleeping
AGENTS = (AGENT, "Claude-User")
PARAGRAPH_MAX_WORDS = 300  # a longer block (a page without paragraph breaks) is split at sentence ends
MAX_JSONLD_BYTES = 300_000
_REDIRECTS = {301, 302, 303, 307, 308}

# A redirect to a path with one of these segments is a sign-in or subscription wall, never followed.
_WALL_SEGMENTS = frozenset(
    {
        "login",
        "log-in",
        "signin",
        "sign-in",
        "sign_in",
        "subscribe",
        "subscription",
        "subscriptions",
        "register",
        "paywall",
        "membership",
        "purchase",
        "checkout",
    }
)
_CONSENT_HOST = re.compile(r"^(?:consent\.|myprivacy\.|privacy\.|guce\.)", re.I)
# Subscription prompts: only ever counted next to a short text (a teaser), never on their own.
_SOFT_WALL = re.compile(
    r"paywall|subscriber-only|subscribers? only|subscribe to (?:continue|read|unlock)|to continue reading|"
    r"already a subscriber|premium-content|piano-(?:offer|template|container)|tp-modal|"
    r"become a (?:member|subscriber) to",
    re.I,
)
# Lines trafilatura sometimes keeps that are page furniture, not the article.
_BOILERPLATE = re.compile(
    r"^(?:advertisements?|ad|sponsored|story continues below(?: this)? advertisement|continue reading below|"
    r"read more|also read|recommended|related(?: stories| articles)?|share this(?: article)?|"
    r"scroll to continue(?: with content)?)[.:…]*$",
    re.I,
)
# A page's own "Published 5 days ago" line, or a related-link list's date under each link (BBC):
# page furniture, never the article. Only when the rest of the line is a date or a time, so a sentence
# such as "Updated guidance was issued on Monday." stays in the article.
_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
_CLOCK = r"\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?(?:\s*(?:[A-Z]{2,5}|GMT[+-]?\d*|UTC[+-]?\d*|PKT|BST))?"
_WHEN = (
    r"(?:\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|months?|years?)\s+ago"
    r"|(?:an?|one)\s+(?:minute|hour|day|week|month|year)\s+ago|just now|yesterday|today"
    rf"|(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:\d{{1,2}}(?:st|nd|rd|th)?\s+{_MONTH},?\s+\d{{4}}"
    rf"|{_MONTH}\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}|\d{{4}}-\d{{2}}-\d{{2}}(?:[T ][\d:.]+Z?)?"
    r"|\d{1,2}/\d{1,2}/\d{2,4}))"
)
_DATELINE = re.compile(
    r"^(?:-\s*)?(?:first published|last updated|published|updated|posted|modified)(?![a-z])\s*(?:on|at)?\s*:?\s*"
    rf"(?:{_WHEN})?\s*(?:[,|·-]?\s*(?:at\s+)?{_CLOCK})?[.\s]*$",
    re.I,
)
_SENTENCE_END = re.compile(r"(?<=[.!?؟۔])\s+")


class Unavailable(Exception):  # noqa: N818 - an outcome, not a bug
    """The full text cannot be had legitimately: final (the job is `blocked` with this reason)."""

    def __init__(self, reason: TranslationBlockReason, note: str):
        super().__init__(f"{reason}: {note}")
        self.reason: TranslationBlockReason = reason
        self.note = note[:1000]


class TryLater(Exception):  # noqa: N818
    """A temporary problem (a 5xx, a timeout, a 429): the job is tried again after `retry_after_s`."""

    def __init__(self, note: str, retry_after_s: int | None = None):
        super().__init__(note)
        self.note = note
        self.retry_after_s = retry_after_s


@dataclass
class FullText:
    url: str
    final_url: str
    route: str
    title: str
    paragraphs: list[str]
    lang: str | None = None
    site_name: str | None = None
    author: str | None = None
    date: str | None = None
    status: int = 200

    @property
    def text(self) -> str:
        return "\n\n".join(self.paragraphs)

    @property
    def words(self) -> int:
        return sum(len(p.split()) for p in self.paragraphs)

    @property
    def text_hash(self) -> str:
        """sha256 hex of the extracted text, so a later request can tell whether the article changed."""
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()


def _origin(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}".lower()


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def is_wall_path(path: str) -> bool:
    """Whether a redirect target is a sign-in or subscription page (`/login`, `/subscribe.html`, ...)."""
    return any(seg.rsplit(".", 1)[0] in _WALL_SEGMENTS for seg in path.lower().split("/"))


def germany_up(proxy_url: str, timeout_s: float = 2.0) -> bool:
    """Whether the Germany SOCKS proxy accepts connections at all (the tunnel is up)."""
    p = urlsplit(proxy_url)
    try:
        with socket.create_connection((p.hostname or "127.0.0.1", p.port or 1080), timeout=timeout_s):
            return True
    except OSError:
        return False


# ---- page signals and extraction -------------------------------------------------------------------
@dataclass
class PageSignals:
    noai: bool = False
    paywall: str | None = None  # why the publisher's own markup says the article is not free
    soft_wall: bool = False  # subscription prompts somewhere on the page
    title: str | None = None


def _not_free(v: Any) -> bool:
    return v is False or (isinstance(v, str) and v.strip().lower() in ("false", "no", "0"))


def _jsonld_not_free(node: Any, depth: int = 0) -> bool:
    if depth > 8:
        return False
    if isinstance(node, list):
        return any(_jsonld_not_free(x, depth + 1) for x in node[:200])
    if not isinstance(node, dict):
        return False
    for k, v in node.items():
        if k == "isAccessibleForFree" and _not_free(v):
            return True
        if isinstance(v, dict | list) and _jsonld_not_free(v, depth + 1):
            return True
    return False


def page_signals(page: bytes | str, headers: dict[str, str] | None = None) -> PageSignals:
    sig = PageSignals()
    if "noai" in (headers or {}).get("x-robots-tag", "").lower():
        sig.noai = True
    if isinstance(page, bytes):
        with contextlib.suppress(UnicodeDecodeError):
            page = page.decode("utf-8")
    if isinstance(page, str):
        page = re.sub(r"^\s*<\?xml[^>]*\?>", "", page, count=1)
    if not page or not page.strip():
        return sig
    try:
        doc = lxml_html.document_fromstring(page)
    except (ValueError, lxml_html.etree.ParserError):
        return sig
    for m in doc.iter("meta"):
        key = (m.get("name") or m.get("property") or "").strip().lower()
        content = (m.get("content") or "").strip().lower()
        if key in ("robots", "teenpehr", "claude-user") and re.search(r"\bnoai\b", content):
            sig.noai = True
        elif key == "article:content_tier" and content in ("locked", "metered"):
            sig.paywall = f"the publisher marks the article as {content} (article:content_tier)"
        elif key == "og:title" and content and not sig.title:
            sig.title = " ".join((m.get("content") or "").split())
    if not sig.paywall:
        for s in doc.iter("script"):
            if (s.get("type") or "").strip().lower() != "application/ld+json":
                continue
            text = s.text or ""
            if not text.strip() or len(text) > MAX_JSONLD_BYTES:
                continue
            try:
                data = json.loads(text)
            except (ValueError, RecursionError):
                continue
            if _jsonld_not_free(data):
                sig.paywall = "the publisher marks the article as not free to read (isAccessibleForFree: false)"
                break
    raw = page if isinstance(page, str) else page.decode("utf-8", "ignore")
    sig.soft_wall = bool(_SOFT_WALL.search(raw))
    return sig


def _split_long(p: str, max_words: int = PARAGRAPH_MAX_WORDS) -> list[str]:
    if len(p.split()) <= max_words:
        return [p]
    out: list[str] = []
    cur: list[str] = []
    n = 0
    for s in _SENTENCE_END.split(p):
        w = len(s.split())
        if cur and n + w > max_words:
            out.append(" ".join(cur))
            cur, n = [], 0
        cur.append(s)
        n += w
    if cur:
        out.append(" ".join(cur))
    return out


def clean_paragraphs(text: str, title: str = "") -> list[str]:
    """One paragraph per line of trafilatura's text: whitespace collapsed, page furniture dropped (ad
    labels, "read more", publication dates and the related links they date), a first line that only
    repeats the headline dropped, very long blocks split at sentence ends."""
    kept: list[str] = []
    for raw in text.split("\n"):
        line = " ".join(raw.split())
        if not line or _BOILERPLATE.match(line):
            continue
        if _DATELINE.match(line):
            if line.startswith("-") and kept and kept[-1].startswith("- "):
                kept.pop()  # the related link this date belongs to
            continue
        kept.append(line)
    lines = kept
    if lines and title and lines[0].casefold().strip(" .") == title.casefold().strip(" ."):
        lines = lines[1:]
    out: list[str] = []
    for line in lines:
        out.extend(_split_long(line))
    return out


def extract_full(page: bytes | str, url: str) -> tuple[str, list[str], dict[str, str | None]]:
    """(page title, paragraphs, metadata) of an article page; no paragraphs when nothing was extracted."""
    if isinstance(page, bytes):
        page = page.decode("utf-8", "ignore")
    try:
        doc = trafilatura.bare_extraction(
            page,
            url=url,
            include_comments=False,
            include_tables=False,
            include_images=False,
            include_links=False,
            include_formatting=False,
            # Off: trafilatura's deduplication remembers text across calls for the whole process, so a
            # second extraction of the same article (a retry in this long-lived runner) would lose paragraphs.
            deduplicate=False,
            with_metadata=True,
        )
    except Exception as e:  # noqa: BLE001 - trafilatura/lxml on hostile markup
        logger.info("extraction failed for %s: %s", url, e)
        return "", [], {}
    if doc is None or not getattr(doc, "text", None):
        return "", [], {}
    title = " ".join((doc.title or "").split()) if isinstance(doc.title, str) else ""
    meta = {
        "site_name": doc.sitename if isinstance(doc.sitename, str) else None,
        "author": doc.author if isinstance(doc.author, str) else None,
        "date": doc.date if isinstance(doc.date, str) else None,
    }
    return title, clean_paragraphs(doc.text, title), meta


# ---- the fetcher ------------------------------------------------------------------------------------
class FullTextFetcher:
    """One per job runner. robots.txt is kept per (origin, route) for ROBOTS_TTL_S."""

    def __init__(
        self,
        fetcher: Fetcher,
        settings: Settings,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        germany_check: Callable[[], bool] | None = None,
    ):
        self.fetcher = fetcher
        self.s = settings
        self._clock = clock
        self._sleep = sleep
        self._germany_check = germany_check or (lambda: germany_up(settings.germany_proxy))
        self._robots: dict[tuple[str, str], tuple[float, Robots]] = {}
        self._last: dict[str, float] = {}

    # ---- robots.txt ---------------------------------------------------------------------------
    def _temporary(self, note: str, last_attempt: bool, retry_after_s: int | None = None) -> Exception:
        return Unavailable("unreachable", note) if last_attempt else TryLater(note, retry_after_s)

    def _robots_for(self, origin: str, route: str, last_attempt: bool) -> tuple[Robots, str]:
        """(robots.txt, the route that reached the host). Raises Unavailable or TryLater."""
        hit = self._robots.get((origin, route))
        if hit and self._clock() - hit[0] < ROBOTS_TTL_S:
            return hit[1], route
        host = _host(origin)
        if route == "germany" and not self._germany_check():
            raise Unavailable(
                "needs_germany", f"{host} is read through the Germany route, which is down; the article cannot be had"
            )
        res = self.fetcher.get(
            f"{origin}/robots.txt",
            route=route,
            headers={"Accept": "text/plain,*/*;q=0.8"},
            allow_fallback=False,
            max_bytes=ROBOTS_MAX_BYTES,
        )
        self._last[origin] = self._clock()
        if res.ok:
            robots = Robots(res.content.decode("utf-8", "replace"))
        elif res.refused:
            raise Unavailable("unreachable", f"{host} is not a public internet address")
        elif res.rate_limited:
            raise TryLater(f"{host} asked us to slow down (429)", int(res.retry_after_s or 900))
        elif res.status == 0 and res.blocked:
            if route == "direct":
                if not self._germany_check():
                    raise Unavailable(
                        "needs_germany",
                        f"{host} cannot be reached from Pakistan ({(res.error or '')[:120]}) and the Germany route is "
                        "down",
                    )
                logger.info("%s unreachable directly (%s); trying the Germany route for reach", host, res.error)
                return self._robots_for(origin, "germany", last_attempt)
            raise self._temporary(f"{host} did not answer through Germany ({(res.error or '')[:120]})", last_attempt)
        elif res.status == 0 or res.status >= 500 or res.status == 429:
            # RFC 9309: an unreachable robots.txt means "disallow everything" for now.
            why = res.error or f"http {res.status}"
            raise self._temporary(f"{host}/robots.txt could not be read ({why[:120]})", last_attempt, 600)
        else:
            robots = Robots()  # 4xx: no robots.txt, no rules
        self._robots[(origin, route)] = (self._clock(), robots)
        return robots, route

    def _space(self, origin: str, delay: float | None) -> None:
        last = self._last.get(origin)
        if last is None or not delay:
            return
        wait = last + delay - self._clock()
        if wait > MAX_CRAWL_WAIT_S:
            raise TryLater(f"{_host(origin)} asks for {delay:.0f} s between requests", int(wait) + 1)
        if wait > 0:
            self._sleep(wait)

    # ---- the page -----------------------------------------------------------------------------
    def fetch(self, url: str, *, route: str = "direct", last_attempt: bool = False, title_hint: str = "") -> FullText:
        """The article's full text. Raises Unavailable (final) or TryLater (temporary; on the job's last
        attempt a temporary problem is final too: `unreachable`)."""
        p = urlsplit(url)
        if p.scheme not in ("http", "https") or not p.hostname:
            raise Unavailable("not_article", "not a web link")
        current, route_used = url, route
        res: FetchResult | None = None
        for hop in range(MAX_HOPS + 1):
            origin = _origin(current)
            host = _host(current)
            robots, route_used = self._robots_for(origin, route_used, last_attempt)
            for agent in AGENTS:
                if not robots.allowed(current, agent):
                    who = "this page" if agent == AGENT else "fetches an AI makes for a reader (Claude-User)"
                    raise Unavailable("robots_disallowed", f"{host}'s robots.txt does not allow {who}")
            # The longer Crawl-delay of the two groups this fetch answers to.
            self._space(origin, max((robots.crawl_delay(a) or 0.0 for a in AGENTS), default=0.0) or None)
            cool = self.fetcher.cooldown_left(current)
            if cool > 0:
                raise TryLater(f"{host} is cooling down after a 429", int(cool) + 1)
            res = self.fetcher.get(
                current, route=route_used, allow_fallback=False, follow_redirects=False, max_bytes=MAX_PAGE_BYTES
            )
            self._last[origin] = self._clock()
            location = res.headers.get("location") if res.status in _REDIRECTS else None
            if not location:
                break
            nxt = urljoin(current, location)
            np = urlsplit(nxt)
            if np.scheme not in ("http", "https") or not np.hostname:
                raise Unavailable("unreachable", "the page redirects somewhere that is not a web page")
            if _CONSENT_HOST.match(np.hostname):
                raise Unavailable("unreachable", f"{host} sends readers to a consent page first ({np.hostname})")
            if is_wall_path(np.path or "/"):
                raise Unavailable("paywalled", f"{host} redirects to a sign-in or subscription page")
            if hop == MAX_HOPS:
                raise Unavailable("unreachable", f"more than {MAX_HOPS} redirects")
            current = nxt
        assert res is not None
        return self._page(url, current, route_used, res, last_attempt, title_hint)

    def _page(
        self, url: str, final: str, route: str, res: FetchResult, last_attempt: bool, title_hint: str
    ) -> FullText:
        host = _host(final)
        if res.refused:
            raise Unavailable("unreachable", f"{host} is not a public internet address")
        if res.rate_limited:
            raise TryLater(f"{host} asked us to slow down (429)", int(res.retry_after_s or 900))
        if res.status == 0:
            why = (res.error or "no answer")[:160]
            raise self._temporary(f"{host} did not answer ({why})", last_attempt, 300 if res.timed_out else None)
        if res.status in (401, 402):
            raise Unavailable("paywalled", f"{host} asks for a subscription or sign-in (HTTP {res.status})")
        if res.status in (403, 451):
            raise Unavailable(
                "unreachable", f"{host} refused the request (HTTP {res.status}); Tabayyun does not try other ways in"
            )
        if res.status in (404, 410):
            raise Unavailable("unreachable", f"the article is no longer on {host} (HTTP {res.status})")
        if res.status in (408, 425) or res.status >= 500:
            raise self._temporary(f"{host} answered HTTP {res.status}", last_attempt, 600)
        if not res.ok:
            raise Unavailable("unreachable", f"{host} answered HTTP {res.status}")
        ctype = res.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if ctype and "html" not in ctype:
            raise Unavailable("not_article", f"the link is not a web page ({ctype})")
        sig = page_signals(res.content, res.headers)
        if sig.noai:
            raise Unavailable("robots_disallowed", f"{host} opts out of AI use of its pages (noai)")
        if sig.paywall:
            raise Unavailable("paywalled", sig.paywall)
        page_title, paragraphs, meta = extract_full(res.content, final)
        title = " ".join(title_hint.split()) or page_title or (sig.title or "")
        if paragraphs and title and paragraphs[0].casefold().strip(" .") == title.casefold().strip(" ."):
            paragraphs = paragraphs[1:]
        text = FullText(
            url=url,
            final_url=final,
            route=route,
            title=title,
            paragraphs=paragraphs,
            site_name=meta.get("site_name"),
            author=meta.get("author"),
            date=meta.get("date"),
            status=res.status,
        )
        words = text.words
        if not paragraphs:
            if sig.soft_wall:
                raise Unavailable("paywalled", f"{host} shows subscription prompts and no article text")
            raise Unavailable("no_text", "no article text could be found on the page (a video, gallery or live page?)")
        text.lang = detect_lang(text.text[:5000])
        if text.lang == "ur":
            raise Unavailable("not_article", "the article is already in Urdu")
        if words < self.s.translate_min_words:
            if sig.soft_wall:
                raise Unavailable("paywalled", f"only {words} words are free to read on {host}; the rest is paywalled")
            raise Unavailable("no_text", f"the page has only {words} words of text (a teaser, video or live page?)")
        if words > self.s.translate_max_words:
            limit = self.s.translate_max_words
            raise Unavailable("too_long", f"{words} words; full translations are limited to {limit}")
        return text
