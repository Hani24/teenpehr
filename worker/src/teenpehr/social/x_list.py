"""X (Twitter) public List timelines through the syndication (embed) endpoint.

`https://syndication.twitter.com/srv/timeline-list/list-id/<id>` returns an HTML page whose
`__NEXT_DATA__` JSON holds the latest ~100 posts from every member of a public List. No login,
no API key. Rate limit observed: ~50 requests per 15 minutes per IP; keep 5 s between calls."""

from __future__ import annotations

import json
import re
import time
from datetime import UTC, datetime
from typing import Any

from .. import log
from ..models import PostIn

logger = log.get("social.x_list")

LIST_URL = "https://syndication.twitter.com/srv/timeline-list/list-id/{list_id}"
PROFILE_URL = "https://syndication.twitter.com/srv/timeline-profile/screen-name/{handle}"
_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)
_HEALTH_MIN_ENTRIES = 5


class XListError(RuntimeError):
    pass


def parse_created_at(value: str) -> datetime:
    """'Wed Sep 23 14:17:38 +0000 2026' → aware datetime."""
    return datetime.strptime(value, "%a %b %d %H:%M:%S %z %Y").astimezone(UTC)


def _expand_urls(text: str, tweet: dict[str, Any]) -> str:
    for u in tweet.get("entities", {}).get("urls", []) or []:
        short, full = u.get("url"), u.get("expanded_url")
        if short and full:
            text = text.replace(short, full)
    return text


def tweet_to_post(tweet: dict[str, Any]) -> PostIn | None:
    user = tweet.get("user") or {}
    handle = user.get("screen_name")
    tid = tweet.get("id_str") or (str(tweet["id"]) if tweet.get("id") else None)
    if not handle or not tid:
        return None
    rt = tweet.get("retweeted_status")
    source = rt or tweet
    text = source.get("full_text") or source.get("text") or ""
    text = _expand_urls(text, source)
    if rt:
        orig = (rt.get("user") or {}).get("screen_name", "")
        text = f"RT @{orig}: {text}" if orig else text
    created = tweet.get("created_at")
    try:
        posted_at = parse_created_at(created) if created else datetime.now(UTC)
    except ValueError:
        posted_at = datetime.now(UTC)
    raw = {
        "lang": tweet.get("lang"),
        "retweet_of": (rt.get("user") or {}).get("screen_name") if rt else None,
        "retweet_id": rt.get("id_str") if rt else None,
        "reply_count": tweet.get("reply_count"),
        "retweet_count": tweet.get("retweet_count"),
        "favorite_count": tweet.get("favorite_count"),
        "media": [m.get("media_url_https") for m in (tweet.get("extended_entities") or {}).get("media", []) or []],
    }
    return PostIn(
        platform="x",
        platform_id=str(tid),
        author_handle=handle,
        author_name=user.get("name") or "",
        text=text.strip(),
        url=f"https://x.com/{handle}/status/{tid}",
        posted_at=posted_at,
        is_repost=bool(rt),
        raw=raw,
    )


def parse_timeline_html(html: str) -> list[PostIn]:
    """Extract posts from a syndication timeline page (list or profile)."""
    m = _NEXT_DATA_RE.search(html)
    if not m:
        raise XListError("no __NEXT_DATA__ in response (endpoint changed or blocked)")
    try:
        data = json.loads(m.group(1))
        entries = data["props"]["pageProps"]["timeline"]["entries"]
    except (ValueError, KeyError, TypeError) as e:
        raise XListError(f"unexpected __NEXT_DATA__ shape: {e}") from e
    posts: list[PostIn] = []
    for entry in entries:
        tweet = (entry.get("content") or {}).get("tweet")
        if not tweet:
            continue
        post = tweet_to_post(tweet)
        if post:
            posts.append(post)
    return posts


def health(posts: list[PostIn], *, stale_hours: float = 6.0, now: datetime | None = None) -> str | None:
    """None when healthy, else a one-line reason (the signal that X closed the endpoint)."""
    if len(posts) < _HEALTH_MIN_ENTRIES:
        return f"only {len(posts)} entries"
    newest = max(p.posted_at for p in posts)
    age_h = ((now or datetime.now(UTC)) - newest).total_seconds() / 3600
    if age_h > stale_hours:
        return f"newest post is {age_h:.1f} h old"
    return None


class XListClient:
    """Fetches list timelines with spacing; `fetch_fn(url, headers) -> str` is injectable for tests."""

    def __init__(self, fetch_fn, *, spacing_s: float = 5.0):
        self._fetch = fetch_fn
        self._spacing = spacing_s
        self._last = 0.0

    def _throttle(self) -> None:
        wait = self._spacing - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def _get(self, url: str) -> str:
        self._throttle()
        return self._fetch(url, {"Accept": "text/html,application/xhtml+xml"})

    def list_posts(self, list_id: str) -> list[PostIn]:
        return parse_timeline_html(self._get(LIST_URL.format(list_id=list_id)))

    def profile_posts(self, handle: str) -> list[PostIn]:
        return parse_timeline_html(self._get(PROFILE_URL.format(handle=handle)))
