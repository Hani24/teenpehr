"""Google News RSS query feeds. Titles carry a ' - Outlet' suffix and links are encrypted
redirect wrappers (news.google.com/rss/articles/<id>) that need decoding to the publisher URL.

Decoding order: the id itself for pre-2024 links (free), then Google's own two-step exchange:
GET the article page for its signature and timestamp, POST those to batchexecute for the URL.
With a Fetcher both requests go through it (per-host lock, Chrome fingerprint, 429 cooldown);
googlenewsdecoder supplies only the parsers for Google's formats, which is the part that breaks
when Google changes something, so a library update carries the fix."""

from __future__ import annotations

import base64
import re
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING
from urllib.parse import urljoin, urlsplit

from .. import log
from ..normalize import strip_outlet_suffix
from .http import host_lock, host_of

if TYPE_CHECKING:
    from .http import Fetcher, FetchResult

logger = log.get("fetch.gnews")

GNEWS_HOST = "news.google.com"
DECODE_SPACING_S = 1.0  # between article-page fetches, as googlenewsdecoder's own `interval`
_ARTICLE_RE = re.compile(r"news\.google\.com/(?:rss/)?articles/([^?/]+)")
_GOOGLE_HOST_RE = re.compile(r"(?:^|\.)google\.[a-z]{2,3}(?:\.[a-z]{2})?$")
_FORM = {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"}

_pace_lock = threading.Lock()
_last_page = 0.0
_LIBRARY_MAX_MISSES = 3  # failures in a row: Google is refusing us, so stop asking
_library_misses = 0


def _is_google(url: str) -> bool:
    """Any Google host (news., www., consent., google.com.pk ...) is a wrapper or a block page,
    never the publisher."""
    return bool(_GOOGLE_HOST_RE.search((urlsplit(url).hostname or "").lower()))


def _pace() -> None:
    """Space article-page fetches across every thread (they all go to one host)."""
    global _last_page
    with _pace_lock:
        wait = DECODE_SPACING_S - (time.monotonic() - _last_page)
        if wait > 0:
            time.sleep(wait)
        _last_page = time.monotonic()


def _decode_legacy(article_id: str) -> str | None:
    """Pre-2024 ids were base64 of a protobuf that contained the URL in clear."""
    try:
        raw = base64.urlsafe_b64decode(article_id + "=" * (-len(article_id) % 4))
    except ValueError:
        return None
    m = re.search(rb"(https?://[^\x00-\x20\"']{8,})", raw)
    if not m:
        return None
    url = m.group(1).decode("utf-8", "ignore")
    return url if "news.google.com" not in url else None


def _parsers():
    # googlenewsdecoder 0.2.x keeps its network-free parsers in `_parse`; pyproject pins <0.3.
    try:
        from googlenewsdecoder import _parse
    except ImportError:  # pragma: no cover
        return None
    return _parse


def _article_page(fetcher: Fetcher, url: str, route: str) -> tuple[FetchResult, str | None]:
    """Google's article page, following only redirects within news.google.com (as
    googlenewsdecoder does). Any other redirect ends the walk and is returned unfetched: off
    Google it is the publisher URL; to another Google host (the /sorry block page, a consent
    wall) it is a refusal that every other link would meet too."""
    page = fetcher.get(url, route=route, allow_fallback=False, follow_redirects=False)
    for _ in range(3):
        location = page.headers.get("location") if 300 <= page.status < 400 else None
        if not location:
            break
        nxt = urljoin(url, location)
        if host_of(nxt) != GNEWS_HOST:
            return page, nxt
        url = nxt
        page = fetcher.get(url, route=route, allow_fallback=False, follow_redirects=False)
    return page, None


def _cooling(fetcher: Fetcher, url: str) -> bool:
    left = getattr(fetcher, "cooldown_left", None)  # duck-typed test fetchers may not have it
    return bool(left and left(url) > 0)


def decode_links(urls: list[str], *, fetcher: Fetcher, route: str = "direct") -> dict[str, str]:
    """Publisher URL for each decodable Google News link; undecodable links are left out.

    One article-page GET per link and a single batchexecute POST for all of them, every request
    through `fetcher`. A 429, or a redirect to Google's /sorry page (treated as one), stops the
    batch and the Fetcher then skips the host for its cooldown; a consent wall stops it too."""
    out: dict[str, str] = {}
    todo: list[str] = []
    links = {u: m.group(1) for u in urls if (m := _ARTICLE_RE.search(u))}
    for u, article_id in links.items():
        legacy = _decode_legacy(article_id)
        if legacy:
            out[u] = legacy
        else:
            todo.append(u)
    gnd = _parsers()
    if not todo or gnd is None:
        return out

    pending: list[tuple[int, str, str, str]] = []  # (index in todo, article id, timestamp, signature)
    for i, u in enumerate(todo):
        art = gnd.article_id(u)
        if not art:
            continue
        if _cooling(fetcher, u):  # a 429 earlier in the run: no request would go out, so no pacing
            logger.info("news.google.com is cooling down; %d links left undecoded", len(todo) - i)
            break
        _pace()
        page, target = _article_page(fetcher, gnd.params_page_url(art, u), route)
        if target and not _is_google(target):
            out[u] = target  # Google redirected to the publisher; its page is not fetched here
            continue
        if target:
            where = urlsplit(target)
            logger.warning(
                "Google News sent the decoder to %s%s; %d links left undecoded",
                where.hostname,
                where.path,
                len(todo) - i,
            )
            if where.path.startswith("/sorry"):  # Google's rate-limit page: honour it as a 429
                cool = getattr(fetcher, "cool_down", None)
                if cool:
                    cool(u)
            break
        if page.rate_limited:
            logger.warning("Google News rate-limited the decoder; %d links left undecoded", len(todo) - i)
            break
        if not page.ok:
            logger.debug("gnews page for %s: %s", art[:24], page.error)
            continue
        parsed = gnd.parse_signature(page.content.decode("utf-8", "replace"))
        if not parsed:
            logger.debug("gnews page for %s has no signature", art[:24])
            continue
        signature, timestamp = parsed
        pending.append((i, art, timestamp, signature))
    if not pending:
        return out

    body = gnd.build_batchexecute_body([(str(i), art, ts, sig) for i, art, ts, sig in pending])
    res = fetcher.post(gnd.BATCHEXECUTE_URL, data=body, route=route, headers=_FORM)
    if not res.ok:
        logger.warning("gnews batchexecute failed for %d links: %s", len(pending), res.error)
        return out
    try:
        pairs = gnd.parse_batchexecute(res.content.decode("utf-8", "replace"))
    except (ValueError, IndexError, TypeError, KeyError) as e:  # json errors are ValueErrors
        logger.warning("gnews batchexecute answer unreadable: %s", e)
        return out
    results = gnd.apply_decoded([gnd.err("pending") for _ in todo], pending, pairs)
    for u, r in zip(todo, results, strict=True):
        decoded = r.get("decoded_url") if r.get("success") else None
        if decoded and not _is_google(str(decoded)):
            out[u] = str(decoded)
    if len(out) < len(links):
        logger.info("gnews: decoded %d of %d links", len(out), len(links))
    return out


def _decode_batchexecute(url: str) -> str | None:
    """googlenewsdecoder's own httpx client, for callers without a Fetcher. It still keeps to one
    request per host (the process-wide news.google.com lock) and to the decode spacing. It cannot
    see a Fetcher's 429 cooldown, so after a few failures in a row it stops for the process."""
    global _library_misses
    try:
        from googlenewsdecoder import gnewsdecoder  # lazy: optional at runtime
    except ImportError:  # pragma: no cover
        return None
    if _library_misses >= _LIBRARY_MAX_MISSES:
        return None
    _pace()
    decoded = None
    with host_lock(GNEWS_HOST):
        if _library_misses >= _LIBRARY_MAX_MISSES:  # again: threads queued on the lock while it gave up
            return None
        try:
            res = gnewsdecoder(url)
        except Exception as e:  # noqa: BLE001 - third-party raises plain Exception
            res = {"success": False, "message": f"{type(e).__name__}: {e}"}
        # 0.2.x: {"success": True, "decoded_url": ...} or {"success": False, "message": ...}
        if isinstance(res, dict) and res.get("success") and res.get("decoded_url"):
            decoded = None if _is_google(str(res["decoded_url"])) else str(res["decoded_url"])
        if decoded:
            _library_misses = 0
        else:
            _library_misses += 1
            logger.debug("gnewsdecoder: %s", res.get("message") if isinstance(res, dict) else res)
            if _library_misses == _LIBRARY_MAX_MISSES:
                logger.warning(
                    "gnewsdecoder failed %d times in a row; not asking Google again this run", _library_misses
                )
    return decoded


def decode_link(
    url: str,
    *,
    fetcher: Fetcher | None = None,
    route: str = "direct",
    follow: Callable[[str], str | None] | None = None,
) -> str:
    """Return the publisher URL for a Google News link, or the link itself when undecodable.

    Pass the run's `fetcher` (see decode_links). Without one: legacy base64, then
    googlenewsdecoder's own client, then the optional redirect follower supplied by the caller."""
    m = _ARTICLE_RE.search(url)
    if not m:
        return url
    if fetcher is not None:
        return decode_links([url], fetcher=fetcher, route=route).get(url, url)
    decoded = _decode_legacy(m.group(1)) or _decode_batchexecute(url)
    if not decoded and follow:
        try:
            final = follow(url)
        except Exception as e:  # noqa: BLE001
            logger.debug("redirect follow failed: %s", e)
            final = None
        if final and not _is_google(final):
            decoded = final
    return decoded or url


def clean_title(title: str) -> str:
    return strip_outlet_suffix(title)
