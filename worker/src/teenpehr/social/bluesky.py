"""Bluesky public API (no auth): app.bsky.feed.getAuthorFeed."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx
from dateutil import parser as dtparser

from ..models import PostIn, PostMedia, PostMetrics
from . import post_with_metadata

BASE = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"


def _count(v: Any) -> int | None:
    return v if isinstance(v, int) and v >= 0 else None


def _metadata(post: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    """Counts, rich-text facets (hashtags, @mentions as written, links), embedded media, language and
    the reply thread (parent and root post URIs)."""
    text_bytes = (record.get("text") or "").encode("utf-8")
    tags: list[str] = []
    mentions: list[str] = []
    urls: list[str] = []
    for facet in record.get("facets") or []:
        index = facet.get("index") or {}
        for f in facet.get("features") or []:
            kind = str(f.get("$type", ""))
            if kind.endswith("#tag") and f.get("tag"):
                tags.append(f["tag"])
            elif kind.endswith("#link") and f.get("uri"):
                urls.append(f["uri"])
            elif kind.endswith("#mention"):
                start, end = index.get("byteStart"), index.get("byteEnd")
                if isinstance(start, int) and isinstance(end, int):
                    mentions.append(text_bytes[start:end].decode("utf-8", "ignore").lstrip("@"))
    media: list[PostMedia] = []
    embed = post.get("embed") or {}
    kind = str(embed.get("$type", ""))
    if kind.startswith("app.bsky.embed.images"):
        for im in embed.get("images") or []:
            if im.get("fullsize"):
                media.append(
                    PostMedia(type="photo", url=im["fullsize"], preview_url=im.get("thumb"), alt=im.get("alt") or None)
                )
    elif kind.startswith("app.bsky.embed.video") and embed.get("playlist"):
        media.append(
            PostMedia(
                type="video", url=embed["playlist"], preview_url=embed.get("thumbnail"), alt=embed.get("alt") or None
            )
        )
    elif kind.startswith("app.bsky.embed.external") and (embed.get("external") or {}).get("uri"):
        urls.append(embed["external"]["uri"])
    reply = record.get("reply") or {}
    langs = record.get("langs") or []
    return {
        "lang": langs[0] if langs and isinstance(langs[0], str) else None,
        "metrics": PostMetrics(
            replies=_count(post.get("replyCount")),
            reposts=_count(post.get("repostCount")),
            likes=_count(post.get("likeCount")),
            quotes=_count(post.get("quoteCount")),
        ),
        "hashtags": tags,
        "mentions": mentions,
        "urls": list(dict.fromkeys(urls)),
        "media": media,
        "in_reply_to": (reply.get("parent") or {}).get("uri"),
        "conversation_id": (reply.get("root") or {}).get("uri"),
    }


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
    base = {
        "platform": "bluesky",
        "platform_id": uri,
        "author_handle": handle,
        "author_name": author.get("displayName") or "",
        "text": (record.get("text") or "").strip(),
        "url": f"https://bsky.app/profile/{handle}/post/{rkey}",
        "posted_at": posted_at,
        "is_repost": reason.get("$type", "").endswith("reasonRepost"),
        "raw": {"cid": post.get("cid")},
    }
    return post_with_metadata(base, lambda: _metadata(post, record))


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
