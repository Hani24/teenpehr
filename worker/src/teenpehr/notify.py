"""ntfy.sh notifications (failure alerts, optional success summaries)."""

from __future__ import annotations

import httpx

from . import log

logger = log.get("notify")


def ntfy(topic: str, title: str, body: str, priority: str = "default") -> bool:
    if not topic:
        return False
    try:
        r = httpx.post(
            f"https://ntfy.sh/{topic}",
            content=body.encode("utf-8"),
            headers={"Title": title, "Priority": priority},
            timeout=15,
        )
        return r.status_code < 300
    except httpx.HTTPError as e:
        logger.warning("ntfy failed: %s", e)
        return False
