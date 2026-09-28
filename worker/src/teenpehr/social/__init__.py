"""Social sources: X list/profile syndication, twitterapi.io fallback, Bluesky."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .. import log
from ..models import PostIn

logger = log.get("social")


def post_with_metadata(base: dict[str, Any], metadata: Callable[[], dict[str, Any]]) -> PostIn:
    """A post with its research metadata (decision D5: counts, tags, links, media, thread). The metadata
    is optional: when a platform answers in a shape the extraction does not expect, the post is kept
    without it rather than lost, along with every other post on the page."""
    try:
        return PostIn(**base, **metadata())
    except Exception as e:  # noqa: BLE001 - any odd shape (KeyError, TypeError, ValidationError)
        logger.debug("%s: metadata left out: %s", base.get("url"), e)
        return PostIn(**base)
