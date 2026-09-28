from datetime import UTC, datetime, timedelta

import pytest

from conftest import fixture_text
from teenpehr.fetch.http import FetchResult
from teenpehr.models import PostIn
from teenpehr.social.x_list import (
    XListClient,
    XListError,
    XRateLimited,
    fetch_html,
    health,
    parse_created_at,
    parse_timeline_html,
)

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


def _posts(n: int, gap: timedelta, newest_age: timedelta) -> list[PostIn]:
    newest = NOW - newest_age
    return [
        PostIn(
            platform_id=str(i),
            author_handle="a",
            text="t",
            url=f"https://x.com/a/status/{i}",
            posted_at=newest - i * gap,
        )
        for i in range(n)
    ]


def test_fixture_parses_all_entries():
    posts = parse_timeline_html(fixture_text("x_list_84839422.html"))
    assert len(posts) == 97
    p = posts[0]
    assert p.platform == "x" and p.platform_id.isdigit()
    assert p.url == f"https://x.com/{p.author_handle}/status/{p.platform_id}"
    assert p.posted_at.tzinfo is not None
    assert sum(1 for x in posts if x.is_repost) == 11
    rt = next(x for x in posts if x.is_repost)
    assert rt.text.startswith("RT @") and rt.raw["retweet_of"]


def test_health_uses_newest_post():
    posts = parse_timeline_html(fixture_text("x_list_84839422.html"))
    newest = max(p.posted_at for p in posts)
    assert health(posts, now=newest) is None
    assert "old" in health(posts, now=newest.replace(year=newest.year + 1))
    assert "entries" in health(posts[:2], now=newest)


def test_parse_created_at():
    assert parse_created_at("Wed Sep 23 14:17:38 +0000 2026") == datetime(2026, 9, 23, 14, 17, 38, tzinfo=UTC)


def test_client_throttles_and_raises_on_bad_html():
    calls = []

    def fetch(url, headers):
        calls.append(url)
        return "<html>no data</html>"

    c = XListClient(fetch, spacing_s=0)
    with pytest.raises(XListError):
        c.list_posts("1")
    assert calls == ["https://syndication.twitter.com/srv/timeline-list/list-id/1"]


def test_health_judges_silence_by_the_lists_own_pace():
    # a busy list (a post every 5 minutes) silent for 7 h: X has probably stopped serving it
    assert "old" in health(_posts(100, timedelta(minutes=5), timedelta(hours=7)), now=NOW)
    # a list of low-volume accounts (a post every 3 h) silent for 8 h overnight: normal
    assert health(_posts(100, timedelta(hours=3), timedelta(hours=8)), now=NOW) is None
    assert "old" in health(_posts(100, timedelta(hours=3), timedelta(hours=20)), now=NOW)
    # however quiet the list, two days without a post is flagged
    assert "old" in health(_posts(100, timedelta(days=1), timedelta(hours=49)), now=NOW)


class _Fetcher:
    def __init__(self, result: FetchResult):
        self.result, self.calls = result, []

    def get(self, url, *, route="direct", headers=None, conditional=False, allow_fallback=True, max_bytes=0):
        self.calls.append((url, allow_fallback, headers))
        return self.result


def test_fetch_html_tells_a_rate_limit_apart():
    html = fixture_text("x_list_84839422.html")
    ok = _Fetcher(FetchResult(url="u", status=200, content=html.encode()))
    assert len(XListClient(fetch_html(ok), spacing_s=0).list_posts("84839422")) == 97
    [(url, allow_fallback, headers)] = ok.calls
    assert url.endswith("/list-id/84839422") and allow_fallback is False and headers["Accept"].startswith("text/html")

    limited = _Fetcher(FetchResult(url="u", status=429, error="skipped: cooling down", rate_limited=True))
    with pytest.raises(XRateLimited):
        XListClient(fetch_html(limited), spacing_s=0).list_posts("1")
    gone = _Fetcher(FetchResult(url="u", status=404, error="http 404"))
    with pytest.raises(XListError) as e:
        XListClient(fetch_html(gone), spacing_s=0).list_posts("1")
    assert not isinstance(e.value, XRateLimited)
