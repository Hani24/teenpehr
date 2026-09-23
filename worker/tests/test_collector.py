from datetime import UTC, datetime

from conftest import fixture_bytes
from teenpehr.fetch.http import FetchResult
from teenpehr.models import Source
from teenpehr.pipeline import Collector


class Fetcher:
    def __init__(self, pages: dict, timeouts: set[str] | None = None):
        self.pages = pages
        self.timeouts = set(timeouts or ())
        self.calls: list[str] = []

    def get(self, url, *, route="direct", headers=None, conditional=False, allow_fallback=True, max_bytes=0):
        self.calls.append(url)
        if url in self.timeouts:
            self.timeouts.discard(url)  # succeed on the retry
            return FetchResult(url=url, status=0, error="ReadTimeout: 25 s", route_used=route, timed_out=True, ms=25000)
        if url in self.pages:
            return FetchResult(url=url, status=200, content=self.pages[url], final_url=url, route_used=route, ms=10)
        return FetchResult(url=url, status=404, error="http 404", route_used=route, ms=3)

    def save_state(self):
        pass


def _src(i, url, **kw):
    return Source(id=i, group_id=1, name=f"s{i}", kind="rss", url=url, **kw)


def test_undated_items_are_kept_inside_the_window(settings):
    url = "https://thenews.test/rss"
    f = Fetcher({url: fixture_bytes("rss_undated.xml")})
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    since = datetime(2026, 9, 23, 0, 0, tzinfo=UTC)
    batch = c.fetch_source(_src(1, url), since)
    titles = [it.title for it in batch.items]
    assert titles == ["Undated headline one", "Undated headline two"]  # the Nov 2025 item is out of window
    assert all(it.published_at is None for it in batch.items)
    assert batch.result.ok and batch.result.items == 2


def test_timed_out_feed_is_retried_once_after_the_others(settings):
    a, b = "https://a.test/rss", "https://b.test/rss"
    f = Fetcher({a: fixture_bytes("atom.xml"), b: fixture_bytes("rss_undated.xml")}, timeouts={b})
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    batches = c.collect([_src(1, a), _src(2, b)], datetime(2020, 1, 1, tzinfo=UTC))
    by = {x.source.id: x for x in batches}
    assert by[2].result.ok and by[2].result.items == 3 and not by[2].timed_out
    assert f.calls.count(b) == 2 and f.calls.index(b, f.calls.index(b) + 1) > f.calls.index(a)


def test_timed_out_twice_is_reported_failed(settings):
    b = "https://b.test/rss"

    class AlwaysTimeout(Fetcher):
        def get(self, url, **kw):
            self.calls.append(url)
            return FetchResult(url=url, status=0, error="ReadTimeout", timed_out=True)

    f = AlwaysTimeout({})
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    [batch] = c.collect([_src(2, b)], datetime(2020, 1, 1, tzinfo=UTC))
    assert not batch.result.ok and "Timeout" in batch.result.error and f.calls.count(b) == 2
