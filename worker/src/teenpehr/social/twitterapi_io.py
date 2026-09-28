"""Optional paid fallback: twitterapi.io `GET /twitter/user/last_tweets` (about 0.003 USD per
call, 20 posts per page). Active only when TWITTERAPI_IO_KEY is set. The response shape below is
what the vendor documented in September 2026; unknown fields are ignored."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx
from dateutil import parser as dtparser

from .. import log
from ..models import PostIn, PostMedia, PostMetrics
from . import post_with_metadata

logger = log.get("social.twitterapi_io")
BASE = "https://api.twitterapi.io"


def _parse_dt(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)
    try:
        d = dtparser.parse(value)
        return (d if d.tzinfo else d.replace(tzinfo=UTC)).astimezone(UTC)
    except (ValueError, OverflowError, TypeError):
        return datetime.now(UTC)


def _count(t: dict[str, Any], *keys: str) -> int | None:
    for k in keys:
        v = t.get(k)
        if isinstance(v, int) and v >= 0:
            return v
    return None


def _metadata(t: dict[str, Any]) -> dict[str, Any]:
    """PostIn metadata from a twitterapi.io tweet (camelCase counts, v1.1-style entities)."""
    ent = t.get("entities") if isinstance(t.get("entities"), dict) else {}
    ext = t.get("extendedEntities") or t.get("extended_entities") or {}
    kinds = {"photo": "photo", "video": "video", "animated_gif": "gif"}
    media: list[PostMedia] = []
    for m in (ext.get("media") if isinstance(ext, dict) else None) or []:
        still = m.get("media_url_https") if isinstance(m, dict) else None
        if isinstance(still, str):
            alt = m.get("ext_alt_text")
            media.append(PostMedia(type=kinds.get(m.get("type"), "other"), url=still, alt=alt or None))  # type: ignore[arg-type]
    return {
        "lang": t.get("lang") if isinstance(t.get("lang"), str) else None,
        "metrics": PostMetrics(
            replies=_count(t, "replyCount", "reply_count"),
            reposts=_count(t, "retweetCount", "retweet_count"),
            likes=_count(t, "likeCount", "favorite_count"),
            quotes=_count(t, "quoteCount", "quote_count"),
            views=_count(t, "viewCount", "view_count"),
            bookmarks=_count(t, "bookmarkCount", "bookmark_count"),
        ),
        "hashtags": [h.get("text") for h in ent.get("hashtags") or [] if isinstance(h, dict) and h.get("text")],
        "mentions": [
            m.get("screen_name") for m in ent.get("user_mentions") or [] if isinstance(m, dict) and m.get("screen_name")
        ],
        "urls": [u.get("expanded_url") for u in ent.get("urls") or [] if isinstance(u, dict) and u.get("expanded_url")],
        "media": media,
        "in_reply_to": str(t.get("inReplyToId") or t.get("in_reply_to_status_id_str") or "") or None,
        "conversation_id": str(t.get("conversationId") or t.get("conversation_id_str") or "") or None,
    }


def _to_post(t: Any, handle: str) -> PostIn | None:
    if not isinstance(t, dict):
        return None
    tid = str(t.get("id") or t.get("id_str") or "")
    if not tid:
        return None
    author = t.get("author") if isinstance(t.get("author"), dict) else {}
    rt = t.get("retweeted_tweet") if isinstance(t.get("retweeted_tweet"), dict) else None
    text = (rt or t).get("text") or ""
    if rt:
        orig = (rt.get("author") or {}).get("userName", "")
        text = f"RT @{orig}: {text}" if orig else text
    base = {
        "platform": "x",
        "platform_id": tid,
        "author_handle": author.get("userName") or handle,
        "author_name": author.get("name") or "",
        "text": text.strip(),
        "url": t.get("url") or f"https://x.com/{handle}/status/{tid}",
        "posted_at": _parse_dt(t.get("createdAt")),
        "is_repost": bool(rt),
        "raw": {"source": "twitterapi.io"},
    }
    return post_with_metadata(base, lambda: _metadata(rt or t))


def last_tweets(api_key: str, handle: str, *, client: httpx.Client | None = None) -> list[PostIn]:
    """The handle's latest page of posts. Raises httpx.HTTPStatusError on a 4xx/5xx (the caller
    tells a bad key, no credit or a 429 apart from a per-handle problem), httpx.HTTPError on
    transport failures and ValueError when a 2xx body is not JSON. An unknown or suspended
    account, or an answer of an unexpected shape, comes back as an empty list."""
    c = client or httpx.Client(timeout=30)
    try:
        r = c.get(f"{BASE}/twitter/user/last_tweets", params={"userName": handle}, headers={"X-API-Key": api_key})
        r.raise_for_status()
        data = r.json()
    finally:
        if client is None:
            c.close()
    if not isinstance(data, dict):
        data = {}
    if str(data.get("status", "")).lower() == "error":
        logger.warning("twitterapi.io %s: %s", handle, str(data.get("msg") or data.get("message") or "error")[:160])
    inner = data.get("data")
    tweets = data.get("tweets") or (inner.get("tweets") if isinstance(inner, dict) else None) or []
    posts = [p for p in (_to_post(t, handle) for t in (tweets if isinstance(tweets, list) else [])) if p]
    logger.info("twitterapi.io %s: %d posts", handle, len(posts))
    return posts
