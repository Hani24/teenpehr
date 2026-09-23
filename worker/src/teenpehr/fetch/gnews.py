"""Google News RSS query feeds. Titles carry a ' - Outlet' suffix and links are encrypted
redirect wrappers (news.google.com/rss/articles/<id>) that need decoding to the publisher URL."""

from __future__ import annotations

import base64
import re
from collections.abc import Callable

from .. import log
from ..normalize import strip_outlet_suffix

logger = log.get("fetch.gnews")

_ARTICLE_RE = re.compile(r"news\.google\.com/(?:rss/)?articles/([^?/]+)")


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


def _decode_batchexecute(url: str) -> str | None:
    try:
        from googlenewsdecoder import gnewsdecoder  # lazy: optional at runtime
    except ImportError:  # pragma: no cover
        return None
    try:
        res = gnewsdecoder(url, interval=1)
    except Exception as e:  # noqa: BLE001 - third-party raises plain Exception
        logger.debug("gnewsdecoder failed: %s", e)
        return None
    if isinstance(res, dict) and res.get("status") and res.get("decoded_url"):
        return str(res["decoded_url"])
    return None


def decode_link(url: str, *, follow: Callable[[str], str | None] | None = None) -> str:
    """Return the publisher URL for a Google News link, or the link itself when undecodable.

    Order: legacy base64 (free), batchexecute via googlenewsdecoder (two requests), then an
    optional redirect follower supplied by the caller."""
    m = _ARTICLE_RE.search(url)
    if not m:
        return url
    decoded = _decode_legacy(m.group(1)) or _decode_batchexecute(url)
    if not decoded and follow:
        try:
            final = follow(url)
        except Exception as e:  # noqa: BLE001
            logger.debug("redirect follow failed: %s", e)
            final = None
        if final and "news.google.com" not in final:
            decoded = final
    return decoded or url


def clean_title(title: str) -> str:
    return strip_outlet_suffix(title)
