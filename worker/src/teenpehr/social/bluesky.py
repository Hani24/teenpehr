"""Bluesky public API (no auth): app.bsky.feed.getAuthorFeed."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx
from dateutil import parser as dtparser

from ..models import PostIn

BASE = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"


def _to_post(item: dict[str, Any]) -> PostIn | None:
    post = item.get("post") or {}
    uri, author, record = post.get("uri", ""), post.get("author") or {}, post.get("record") or {}
    handle = author.get("handle")
    if not uri or not handle:
        return None
    rkey = uri.rsplit("/", 1)[-1]
    created = record.get("createdAt") or post.get("indexedAt")
    try:
        posted_at = dtparser.parse(created).astimezone(UTC) if created else datetime.now(UTC)
    except (ValueError, OverflowError):
        posted_at = datetime.now(UTC)
    reason = item.get("reason") or {}
    return PostIn(
        platform="bluesky",
        platform_id=uri,
        author_handle=handle,
        author_name=author.get("displayName") or "",
        text=(record.get("text") or "").strip(),
        url=f"https://bsky.app/profile/{handle}/post/{rkey}",
        posted_at=posted_at,
        is_repost=reason.get("$type", "").endswith("reasonRepost"),
        raw={"cid": post.get("cid")},
    )


def author_feed(actor: str, *, limit: int = 50, client: httpx.Client | None = None) -> list[PostIn]:
    c = client or httpx.Client(timeout=30)
    try:
        r = c.get(BASE, params={"actor": actor, "limit": limit})
        r.raise_for_status()
        feed = r.json().get("feed", [])
    finally:
        if client is None:
            c.close()
    return [p for p in (_to_post(i) for i in feed) if p]
