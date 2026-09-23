"""Per-profile syndication timelines. Freshness is a lottery (about half of handles return frozen
snapshots), so a profile read is only trusted when its newest post is recent."""

from __future__ import annotations

from datetime import UTC, datetime

from ..models import PostIn
from .x_list import XListClient


def fresh_profile_posts(client: XListClient, handle: str, *, max_age_hours: float = 24.0) -> list[PostIn] | None:
    """Posts when the snapshot is fresh; None when stale or empty (caller should fall back)."""
    posts = client.profile_posts(handle)
    if not posts:
        return None
    newest = max(p.posted_at for p in posts)
    if (datetime.now(UTC) - newest).total_seconds() > max_age_hours * 3600:
        return None
    return posts
