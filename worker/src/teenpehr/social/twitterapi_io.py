"""Optional paid fallback: twitterapi.io `GET /twitter/user/last_tweets` (about 0.003 USD per
call, 20 posts per page). Active only when TWITTERAPI_IO_KEY is set. The response shape below is
what the vendor documented in September 2026; unknown fields are ignored."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx
from dateutil import parser as dtparser

from .. import log
from ..models import PostIn

logger = log.get("social.twitterapi_io")
BASE = "https://api.twitterapi.io"


def _parse_dt(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)
    try:
        d = dtparser.parse(value)
        return (d if d.tzinfo else d.replace(tzinfo=UTC)).astimezone(UTC)
    except (ValueError, OverflowError):
        return datetime.now(UTC)


def _to_post(t: dict[str, Any], handle: str) -> PostIn | None:
    tid = str(t.get("id") or t.get("id_str") or "")
    if not tid:
        return None
    author = t.get("author") or {}
    rt = t.get("retweeted_tweet")
    text = (rt or t).get("text") or ""
    if rt:
        orig = (rt.get("author") or {}).get("userName", "")
        text = f"RT @{orig}: {text}" if orig else text
    return PostIn(
        platform="x",
        platform_id=tid,
        author_handle=author.get("userName") or handle,
        author_name=author.get("name") or "",
        text=text.strip(),
        url=t.get("url") or f"https://x.com/{handle}/status/{tid}",
        posted_at=_parse_dt(t.get("createdAt")),
        is_repost=bool(rt),
        raw={"source": "twitterapi.io"},
    )


def last_tweets(api_key: str, handle: str, *, client: httpx.Client | None = None) -> list[PostIn]:
    c = client or httpx.Client(timeout=30)
    try:
        r = c.get(f"{BASE}/twitter/user/last_tweets", params={"userName": handle}, headers={"X-API-Key": api_key})
        r.raise_for_status()
        data = r.json()
    finally:
        if client is None:
            c.close()
    tweets = data.get("tweets") or (data.get("data") or {}).get("tweets") or []
    posts = [p for p in (_to_post(t, handle) for t in tweets) if p]
    logger.info("twitterapi.io %s: %d posts", handle, len(posts))
    return posts
