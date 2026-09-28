"""X (Twitter) public List timelines through the syndication (embed) endpoint.

`https://syndication.twitter.com/srv/timeline-list/list-id/<id>` returns an HTML page whose
`__NEXT_DATA__` JSON holds the latest ~100 posts from every member of a public List. No login,
no API key. Rate limit observed: ~50 requests per 15 minutes per IP; keep 5 s between calls."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from .. import log
from ..models import PostIn, PostMedia, PostMetrics
from . import post_with_metadata

if TYPE_CHECKING:
    from ..fetch.http import Fetcher

logger = log.get("social.x_list")

LIST_URL = "https://syndication.twitter.com/srv/timeline-list/list-id/{list_id}"
PROFILE_URL = "https://syndication.twitter.com/srv/timeline-profile/screen-name/{handle}"
_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)
_HEALTH_MIN_ENTRIES = 5
_QUIET_GAPS = 6  # silence up to this many of the list's average gaps between posts is normal...
_QUIET_MAX_HOURS = 48.0  # ...but never longer than this


class XListError(RuntimeError):
    pass


class XRateLimited(XListError):
    """X answered 429, or the host is still cooling down from one: stop asking for this run."""


def fetch_html(fetcher: Fetcher) -> Callable[[str, dict[str, str]], str]:
    """An XListClient `fetch_fn` over the run's Fetcher: direct route only (the residential IP
    is the one X lets through), and a rate limit raised apart from other failures."""

    def go(url: str, headers: dict[str, str]) -> str:
        r = fetcher.get(url, headers=headers, allow_fallback=False)
        if r.rate_limited:
            raise XRateLimited(r.error or "http 429")
        if not r.ok:
            raise XListError(r.error or f"http {r.status}")
        return r.content.decode("utf-8", "replace")

    return go


def parse_created_at(value: str) -> datetime:
    """'Wed Sep 23 14:17:38 +0000 2026' → aware datetime."""
    return datetime.strptime(value, "%a %b %d %H:%M:%S %z %Y").astimezone(UTC)


def _expand_urls(text: str, tweet: dict[str, Any]) -> str:
    for u in tweet.get("entities", {}).get("urls", []) or []:
        short, full = u.get("url"), u.get("expanded_url")
        if short and full:
            text = text.replace(short, full)
    return text


def _count(v: Any) -> int | None:
    return v if isinstance(v, int) and v >= 0 else None


def _media(tweet: dict[str, Any]) -> list[PostMedia]:
    """Photos, videos and GIFs with their preview image and alt text; a video's URL is its best MP4."""
    kinds = {"photo": "photo", "video": "video", "animated_gif": "gif"}
    out: list[PostMedia] = []
    for m in (tweet.get("extended_entities") or tweet.get("entities") or {}).get("media") or []:
        still = m.get("media_url_https") or m.get("media_url")
        if not isinstance(still, str):
            continue
        mp4 = [v for v in (m.get("video_info") or {}).get("variants") or [] if v.get("content_type") == "video/mp4"]
        best = max(mp4, key=lambda v: v.get("bitrate") or 0)["url"] if mp4 else None
        alt = m.get("ext_alt_text")
        out.append(
            PostMedia(
                type=kinds.get(m.get("type"), "other"),  # type: ignore[arg-type]
                url=best or still,
                preview_url=still if best else None,
                alt=alt if isinstance(alt, str) and alt else None,
            )
        )
    return out


def tweet_metadata(tweet: dict[str, Any]) -> dict[str, Any]:
    """PostIn metadata from a v1.1-shaped tweet (syndication): counts, hashtags, mentions, links,
    media, language and reply threading. A count X did not send stays None."""
    ent = tweet.get("entities") or {}
    return {
        "lang": tweet.get("lang") if isinstance(tweet.get("lang"), str) else None,
        "metrics": PostMetrics(
            replies=_count(tweet.get("reply_count")),
            reposts=_count(tweet.get("retweet_count")),
            likes=_count(tweet.get("favorite_count")),
            quotes=_count(tweet.get("quote_count")),
            views=_count(tweet.get("view_count")),
            bookmarks=_count(tweet.get("bookmark_count")),
        ),
        "hashtags": [h["text"] for h in ent.get("hashtags") or [] if isinstance(h.get("text"), str)],
        "mentions": [m["screen_name"] for m in ent.get("user_mentions") or [] if isinstance(m.get("screen_name"), str)],
        "urls": [u["expanded_url"] for u in ent.get("urls") or [] if isinstance(u.get("expanded_url"), str)],
        "media": _media(tweet),
        "in_reply_to": tweet.get("in_reply_to_status_id_str") or None,
        "conversation_id": tweet.get("conversation_id_str") or None,
    }


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
    base = {
        "platform": "x",
        "platform_id": str(tid),
        "author_handle": handle,
        "author_name": user.get("name") or "",
        "text": text.strip(),
        "url": f"https://x.com/{handle}/status/{tid}",
        "posted_at": posted_at,
        "is_repost": bool(rt),
        "raw": raw,
    }
    # a repost's content, counts and thread are the original post's
    return post_with_metadata(base, lambda: tweet_metadata(source))


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
    """None when healthy, else a one-line reason (the signal that X closed the endpoint).

    Silence is judged against the list's own pace, as the plan's "on a busy list" intends: the
    newest post may be `stale_hours` old, or a few of the list's average gaps between posts when
    that is longer (capped at two days), so a list of low-volume accounts is not flagged nightly."""
    if len(posts) < _HEALTH_MIN_ENTRIES:
        return f"only {len(posts)} entries"
    times = sorted(p.posted_at for p in posts)
    newest = times[-1]
    avg_gap_h = (newest - times[0]).total_seconds() / 3600 / (len(times) - 1)
    limit_h = min(max(stale_hours, _QUIET_GAPS * avg_gap_h), max(stale_hours, _QUIET_MAX_HOURS))
    age_h = ((now or datetime.now(UTC)) - newest).total_seconds() / 3600
    if age_h > limit_h:
        return f"newest post is {age_h:.1f} h old (over {limit_h:.1f} h for this list's pace)"
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
