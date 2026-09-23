from datetime import UTC, datetime

import pytest

from conftest import fixture_text
from teenpehr.social.x_list import XListClient, XListError, health, parse_created_at, parse_timeline_html


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
