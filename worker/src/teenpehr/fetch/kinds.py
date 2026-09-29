"""One entry point per source kind: fetch a source's URL and turn the answer into feed entries.

- rss: an RSS, Atom or RDF feed; conditional GET. Feeds are published for feed readers, so
  robots.txt is not a gate for them (it is for pages).
- gnews: a Google News RSS query, read like rss; the collector decodes its links.
- youtube: a channel's Atom feed; links become watch?v=.
- sitemap: a publisher's Google News sitemap, or an index of them (its newest one or two children
  are read). Fetched only where robots.txt allows the sitemap's path; children and articles on another
  site than the sitemap's own are dropped (sitemap.site_of). A sitemap lists everything the
  publisher printed (sport, showbiz, the lot), so its URL may end in a fragment that picks sections
  by URL path: `#include=/world/,/india-news/` keeps only articles whose path contains one of those,
  `#exclude=/sport,/entertainment` drops those (both may be given, `&`-separated). A fragment is
  never sent to the server, so the publisher sees the plain sitemap URL.
- gdelt: a GDELT DOC 2.0 artlist API URL; robots.txt honoured; one request per 5 s, process-wide.

`telegram`, `html` and `manual` are not fetched (t.me is blocked from Pakistan without the Germany
route; `manual` sources hold editors' links, D12). The collector and `python -m teenpehr.fetch.audit`
both go through read(), so an audit exercises exactly what a run does."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol
from urllib.parse import parse_qsl, unquote, urlsplit

from .. import log
from . import gdelt, rss, sitemap, youtube
from .http import FetchResult, host_of

if TYPE_CHECKING:
    from .rss import Entry

logger = log.get("fetch.kinds")

FETCHABLE_KINDS = ("rss", "gnews", "youtube", "sitemap", "gdelt")
ROBOTS_KINDS = ("sitemap", "gdelt")  # not feeds: fetched only where robots.txt allows the URL
SITEMAP_MAX_BYTES = 10_000_000  # a news sitemap holds at most 1,000 URLs; a few MB with images

# (url, route) -> may we fetch it? ArticleFetcher.allowed: robots.txt read once per host per run.
Allowed = Callable[[str, str], bool]


class _Source(Protocol):
    kind: str
    url: str
    route: str


class _Getter(Protocol):
    def get(self, url: str, **kw) -> FetchResult: ...


@dataclass
class Feed:
    """What reading one source gave. `res` is the HTTP result that counts (for a sitemap index, the
    last child read; its `ms` covers every request). `entries` is None when nothing was parsed:
    the fetch failed (`res.error`), the feed was unchanged (`res.not_modified`) or the body was
    unusable (`error`)."""

    res: FetchResult
    entries: list[Entry] | None = None
    error: str | None = None  # the body came but could not be read (parse error, GDELT's text error)
    fetched: list[str] = field(default_factory=list)  # every URL requested, for logs and the audit


def parse(kind: str, data: bytes, url: str = "") -> list[Entry]:
    """Entries of one fetched body by source kind. May raise on a body that is not that kind."""
    if kind == "youtube":
        return youtube.parse_channel_feed(data)
    if kind == "sitemap":
        return sitemap.parse_sitemap(data, url).entries
    if kind == "gdelt":
        return gdelt.parse_artlist(data)
    return rss.parse_feed(data, feed_url=url)


def _cooling(fetcher: _Getter, url: str) -> bool:
    left = getattr(fetcher, "cooldown_left", None)  # duck-typed test fetchers may not have it
    return bool(left and left(url) > 0)


def _disallowed(url: str) -> FetchResult:
    return FetchResult(url=url, status=0, error="robots.txt disallows this URL for our agent")


def _refused(fetcher: _Getter, url: str) -> FetchResult:
    """Why robots.txt said no: a 429 on robots.txt itself (the host is now cooling down) is a rate
    limit, not a refusal, and is reported as one."""
    if _cooling(fetcher, url):
        return FetchResult(url=url, status=429, error="http 429 (on robots.txt)", rate_limited=True)
    return _disallowed(url)


def _robots_ok(fetcher: _Getter, url: str, route: str, allowed: Allowed | None) -> bool:
    """robots.txt verdict; a host cooling down after a 429 is left to fetcher.get, which answers
    it locally, so a rate limit is never reported as a robots refusal."""
    if allowed is None or _cooling(fetcher, url):
        return True
    return allowed(url, route)


def _get_gdelt(fetcher: _Getter, url: str, route: str, allowed: Allowed | None) -> FetchResult:
    if not _cooling(fetcher, url) and allowed is not None:
        with gdelt.slot():  # robots.txt is a request to GDELT too, so it takes a slot
            ok = allowed(url, route)
        if not ok:
            return _refused(fetcher, url)
    with gdelt.slot():
        return fetcher.get(url, route=route, allow_fallback=False)


@dataclass
class PathFilter:
    """A sitemap source's section filter, from its URL fragment (see the module docstring)."""

    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()

    @classmethod
    def of(cls, url: str) -> PathFilter:
        frag = urlsplit(url).fragment
        parts = dict(parse_qsl(frag, keep_blank_values=False)) if frag else {}

        def terms(key: str) -> tuple[str, ...]:
            return tuple(t.strip().lower() for t in unquote(parts.get(key, "")).split(",") if t.strip())

        return cls(terms("include"), terms("exclude"))

    def __bool__(self) -> bool:
        return bool(self.include or self.exclude)

    def keep(self, link: str) -> bool:
        path = unquote(urlsplit(link).path).lower()
        if self.include and not any(t in path for t in self.include):
            return False
        return not any(t in path for t in self.exclude)


def _read_sitemap(fetcher: _Getter, source: _Source, conditional: bool, allowed: Allowed | None) -> Feed:
    feed = _read_sitemap_all(fetcher, source, conditional, allowed)
    only = PathFilter.of(source.url)
    if only and feed.entries is not None:
        feed.entries = [e for e in feed.entries if only.keep(e.link)]
    return feed


def _read_sitemap_all(fetcher: _Getter, source: _Source, conditional: bool, allowed: Allowed | None) -> Feed:
    url, route = source.url, source.route
    if not _robots_ok(fetcher, url, route, allowed):
        return Feed(_refused(fetcher, url), fetched=[url])
    res = fetcher.get(url, route=route, conditional=conditional, max_bytes=SITEMAP_MAX_BYTES)
    feed = Feed(res, fetched=[url])
    if not res.ok:
        return feed
    # The publisher's own site (and where it redirected to): a sitemap's children and articles elsewhere are
    # dropped, so a source never cites another outlet's page under its own name or makes us fetch a third
    # party's sitemap.
    sites = {sitemap.site_of(url), sitemap.site_of(res.final_url or url)}
    sm = sitemap.parse_sitemap(res.content, res.final_url or url)
    if not sm.is_index:
        feed.entries = _own(sm.entries, sites, url)
        if not feed.entries and sm.entries:
            feed.error = "parse: the sitemap lists only other sites' pages"
        elif not sm.entries and sm.truncated:
            feed.error = "parse: not a readable sitemap"
        return feed
    # An index: its children change with every article while the index itself may not, so its
    # validators are dropped (the next run reads it in full) and the children are fetched in full.
    forget = getattr(fetcher, "forget", None)
    if forget:
        forget(url)
    children = [c for c in sm.children if sitemap.site_of(c) in sites]
    if not children:
        feed.error = "parse: sitemap index lists no sitemaps" + (" on its own site" if sm.children else "")
        return feed
    entries: dict[str, Entry] = {}
    failed: FetchResult | None = None
    read_any = False
    for child in children[: sitemap.INDEX_CHILDREN]:
        if not _robots_ok(fetcher, child, route, allowed):
            failed = failed or _refused(fetcher, child)
            continue
        r = fetcher.get(child, route=route, max_bytes=SITEMAP_MAX_BYTES)
        feed.fetched.append(child)
        res.ms += r.ms
        if not r.ok:
            failed = failed or r
            continue
        read_any = True
        for en in _own(sitemap.parse_sitemap(r.content, r.final_url or child).entries, sites, child):
            entries.setdefault(en.link, en)
    if not read_any and failed is not None:
        failed.ms = res.ms
        feed.res = failed  # the source failed the way its first child did
        return feed
    feed.entries = sorted(entries.values(), key=_newest_first)
    return feed


def _own(entries: list[Entry], sites: set[str], url: str) -> list[Entry]:
    """The entries whose article is on the publisher's own site."""
    kept = [e for e in entries if sitemap.site_of(e.link) in sites]
    if len(kept) < len(entries):
        logger.info("%s: %d entries on other sites dropped", url, len(entries) - len(kept))
    return kept


def _newest_first(e: Entry) -> float:
    return -(e.published.timestamp() if e.published else float("-inf"))


def read(
    fetcher: _Getter,
    source: _Source,
    *,
    conditional: bool = False,
    allowed: Allowed | None = None,
) -> Feed:
    """Fetch and parse one source. Never raises for a network or parse problem: the Feed says
    what happened. Kinds this worker does not fetch come back as an error without a request."""
    kind, url, route = source.kind, source.url, source.route
    if kind not in FETCHABLE_KINDS:
        return Feed(FetchResult(url=url, status=0, error=f"kind {kind} is not fetched by this worker"))
    if kind == "sitemap":
        return _read_sitemap(fetcher, source, conditional, allowed)
    if kind == "gdelt":
        res = _get_gdelt(fetcher, url, route, allowed)
    else:
        res = fetcher.get(url, route=route, conditional=conditional)
    feed = Feed(res, fetched=[url])
    if not res.ok:
        return feed
    try:
        feed.entries = parse(kind, res.content, res.url)
    except Exception as e:  # noqa: BLE001 - feedparser, expat and GDELT's text answers
        feed.error = f"parse: {type(e).__name__}: {str(e)[:200]}"
    return feed


def interleave_by_host(urls: list[str]) -> list[int]:
    """Indices of `urls` reordered so that one host's URLs are spread out: every host's first URL,
    then every host's second, and so on, each round in the original order. A thread pool working
    through them then waits on a host lock (or GDELT's pace) as little as possible."""
    seen: dict[str, int] = {}
    keyed: list[tuple[int, int]] = []
    for i, u in enumerate(urls):
        h = host_of(u)
        keyed.append((seen.get(h, 0), i))
        seen[h] = seen.get(h, 0) + 1
    return [i for _, i in sorted(keyed)]
