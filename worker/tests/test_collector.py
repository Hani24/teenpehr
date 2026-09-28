import json
from datetime import UTC, datetime

import pytest

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


# ---- 429 cooldown in the real Fetcher (curl session stubbed) ------------------------------------
@pytest.fixture(autouse=True)
def _test_hosts_resolve(monkeypatch):
    """The made-up *.test hosts these tests stub requests for resolve to a public address, so the
    Fetcher's public-address guard (tests/test_fetch_guard.py) lets them through to the stub."""
    import socket

    from teenpehr.fetch import http

    real = http._getaddrinfo

    def fake(host, port, *a, **kw):
        if str(host).endswith(".test"):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", port or 0))]
        return real(host, port, *a, **kw)

    monkeypatch.setattr(http, "_getaddrinfo", fake)


class _Resp:
    def __init__(self, status, headers=None, content=b"", url=""):
        self.status_code, self.headers, self.content, self.url = status, headers or {}, content, url


def _stub_sessions(fetcher, answer):
    calls = []

    def request(method, url, **kw):
        calls.append((method, url))
        return answer(method, url)

    for s in fetcher._sessions.values():
        s.request = request
    return calls


def test_429_cools_the_host_down_and_later_requests_stay_local(settings):
    from teenpehr.fetch.http import Fetcher

    f = Fetcher(settings)
    calls = _stub_sessions(
        f,
        lambda m, u: _Resp(429, {"Retry-After": "120"}, url=u) if "a.test" in u else _Resp(200, content=b"ok", url=u),
    )
    first = f.get("https://a.test/rss")
    assert first.rate_limited and first.error.startswith("http 429") and first.retry_after_s == 120
    again = f.get("https://a.test/article/1", route="germany")  # another path, another route: same host
    post = f.post("https://a.test/api", data="x=1")
    assert again.rate_limited and again.error.startswith("skipped") and 110 < again.retry_after_s <= 120
    assert post.rate_limited and not again.ok
    assert f.get("https://b.test/rss").ok
    assert calls == [("GET", "https://a.test/rss"), ("GET", "https://b.test/rss")]

    # the next run (a new Fetcher on the same state directory) honours the Retry-After too
    f2 = Fetcher(settings)
    calls2 = _stub_sessions(f2, lambda m, u: _Resp(200, content=b"ok", url=u))
    assert f2.get("https://a.test/rss").rate_limited and calls2 == []


def test_429_without_retry_after_uses_the_default_cooldown(settings):
    from teenpehr.fetch import http

    f = http.Fetcher(settings)
    _stub_sessions(f, lambda m, u: _Resp(429, url=u))
    assert f.get("https://c.test/x").retry_after_s is None
    assert http.DEFAULT_COOLDOWN_S - 5 < f.cooldown_left("https://c.test/y") <= http.DEFAULT_COOLDOWN_S


def test_parse_retry_after():
    from teenpehr.fetch.http import parse_retry_after

    assert parse_retry_after("30") == 30
    assert parse_retry_after(None) is None and parse_retry_after("soon") is None
    now = datetime(2026, 9, 23, 7, 0, tzinfo=UTC).timestamp()
    assert parse_retry_after("Wed, 23 Sep 2026 07:05:00 GMT", now=now) == 300
    assert parse_retry_after("Wed, 23 Sep 2026 06:00:00 GMT", now=now) == 0


def test_post_sends_script_headers(settings):
    from teenpehr.fetch.http import Fetcher

    f = Fetcher(settings)
    seen = {}

    def request(method, url, **kw):
        seen.update(kw, method=method)
        return _Resp(200, content=b"done", url=url)

    f._sessions["direct"].request = request
    res = f.post("https://news.google.test/_/batch", data="f.req=1", headers={"Content-Type": "x", "User-Agent": "no"})
    assert res.ok and res.content == b"done" and seen["method"] == "POST" and seen["data"] == "f.req=1"
    assert seen["headers"]["Origin"] == "https://news.google.test" and seen["headers"]["Sec-Fetch-Mode"] == "cors"
    assert "User-Agent" not in seen["headers"]


# ---- robots.txt -------------------------------------------------------------------------------
def test_robots_longest_match_wildcards_and_groups():
    from teenpehr.fetch.robots import Robots

    r = Robots(
        "User-agent: GPTBot\nDisallow: /\n\n"
        "User-agent: *\nDisallow: /\nAllow: /news/\nDisallow: /news/*?output=amp\nDisallow: /*.pdf$\n"
        "Allow: /p\nDisallow: /p\nDisallow: /%7Eeditor\nCrawl-delay: 5\n"
    )
    assert r.allowed("https://x.test/news/2026/story")
    assert not r.allowed("https://x.test/opinion/2026/story")  # Python 3.12's robotparser gets these two wrong
    assert not r.allowed("https://x.test/news/story?output=amp")
    assert not r.allowed("https://x.test/news/report.pdf") and r.allowed("https://x.test/news/report.pdf.html")
    assert r.allowed("https://x.test/p")  # Allow wins a tie
    assert not r.allowed("https://x.test/~editor/notes")  # %7E and ~ are the same
    assert r.allowed("https://x.test/robots.txt")
    assert r.crawl_delay() == 5


def test_robots_our_own_group_replaces_the_star_group():
    from teenpehr.fetch.robots import Robots

    r = Robots("User-agent: teenpehr/1.0\nUser-agent: other\nDisallow: /private\n\nUser-agent: *\nDisallow: /\n")
    assert r.allowed("https://x.test/news/1") and not r.allowed("https://x.test/private/1")
    assert not r.allowed("https://x.test/news/1", agent="someone-else")


def test_robots_missing_and_unreachable():
    from teenpehr.fetch.robots import Robots

    assert Robots().allowed("https://x.test/anything") and Robots("").crawl_delay() is None
    assert not Robots.unreachable().allowed("https://x.test/anything")


# ---- article bodies -----------------------------------------------------------------------------
def _article(tag: str) -> bytes:
    # unique text per page: trafilatura's deduplicate=True remembers paragraphs across calls
    return (
        f"<html><head><title>Rain in Karachi {tag}</title></head><body><article><h1>Rain in Karachi</h1>"
        + "".join(
            f"<p>Paragraph {i} of {tag}: heavy monsoon rain flooded several roads in Karachi on Tuesday, officials "
            "said, and the city administration opened relief camps for residents of low-lying areas.</p>"
            for i in range(6)
        )
        + "</article></body></html>"
    ).encode()


class SiteFetcher(Fetcher):
    """Pages by URL, plus robots.txt answers by host: bytes, or an int status."""

    def __init__(self, pages, robots):
        super().__init__(pages)
        self.robots = robots

    def get(self, url, *, route="direct", headers=None, conditional=False, allow_fallback=True, max_bytes=0):
        if url.endswith("/robots.txt"):
            self.calls.append(url)
            host = url.split("/")[2]
            answer = self.robots.get(host, 404)
            if isinstance(answer, bytes):
                return FetchResult(url=url, status=200, content=answer, final_url=url, route_used=route)
            return FetchResult(
                url=url, status=answer, error=f"http {answer}" if answer else "timeout", route_used=route
            )
        return super().get(url, route=route)


def test_article_fetcher_honours_robots_and_reads_it_once_per_host():
    from teenpehr.fetch.article import ArticleFetcher

    urls = ["https://ok.test/news/1", "https://ok.test/news/2", "https://ok.test/private/1"]
    urls += ["https://norobots.test/a", "https://down.test/a"]
    pages = {u: _article(u) for u in urls}
    f = SiteFetcher(pages, {"ok.test": b"User-agent: *\nDisallow: /private/\n", "down.test": 503})
    a = ArticleFetcher(f)
    assert "monsoon rain" in a.fetch_text("https://ok.test/news/1")
    assert "monsoon rain" in a.fetch_text("https://ok.test/news/2")
    assert a.fetch_text("https://ok.test/private/1") == "" and not a.allowed("https://ok.test/private/1")
    assert "monsoon rain" in a.fetch_text("https://norobots.test/a")  # 404: no rules
    assert a.fetch_text("https://down.test/a") == ""  # 5xx: RFC 9309 says stay out
    assert f.calls.count("https://ok.test/robots.txt") == 1
    assert "https://ok.test/private/1" not in f.calls and "https://down.test/a" not in f.calls


def test_article_fetcher_skips_rather_than_waiting_out_a_long_crawl_delay():
    from teenpehr.fetch.article import ArticleFetcher

    pages = {u: _article(u) for u in ("https://slow.test/1", "https://slow.test/2")}
    f = SiteFetcher(pages, {"slow.test": b"User-agent: *\nCrawl-delay: 60\n"})
    a = ArticleFetcher(f)
    assert a.fetch_text("https://slow.test/1") and a.fetch_text("https://slow.test/2") == ""
    assert "https://slow.test/2" not in f.calls


def test_get_can_leave_redirects_to_the_caller(settings):
    from teenpehr.fetch.http import Fetcher

    f = Fetcher(settings)
    seen = []

    def request(method, url, **kw):
        seen.append(kw["allow_redirects"])
        return _Resp(302, {"Location": "https://pub.test/a"}, url=url)

    f._sessions["direct"].request = request
    res = f.get("https://g.test/x", follow_redirects=False)
    assert seen == [False] and res.status == 302 and res.headers["location"] == "https://pub.test/a" and not res.ok


def test_article_fetcher_reports_a_cooling_host_as_not_allowed():
    from teenpehr.fetch.article import ArticleFetcher

    class Cooling(SiteFetcher):
        def cooldown_left(self, url):
            return 600.0 if "hot.test" in url else 0.0

    f = Cooling({}, {})
    a = ArticleFetcher(f)
    assert not a.allowed("https://hot.test/a") and a.allowed("https://cool.test/a")
    assert f.calls == ["https://cool.test/robots.txt"]  # the cooling host is not even asked for robots.txt


# ---- wiring in the Collector: robots.txt, the run's Fetcher for Google News, unparseable feeds ------
def test_article_bodies_follow_robots_txt_before_spending_the_budget(settings):
    feed = (
        b'<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>'
        b"<item><title>Open page</title><link>https://ok.test/news/1</link></item>"
        b"<item><title>Closed page</title><link>https://ok.test/private/2</link></item>"
        b"</channel></rss>"
    )
    pages = {
        "https://feed.test/rss": feed,
        "https://ok.test/news/1": _article("1"),
        "https://ok.test/private/2": _article("2"),
    }
    f = SiteFetcher(pages, {"ok.test": b"User-agent: *\nDisallow: /private/\n"})
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    batch = c.fetch_source(_src(1, "https://feed.test/rss"), datetime(2020, 1, 1, tzinfo=UTC))
    by = {it.title: it for it in batch.items}
    assert "monsoon rain" in by["Open page"].text and by["Closed page"].text == ""
    assert "https://ok.test/private/2" not in f.calls
    assert c._article_budget == settings.article_fetch_limit - 1  # the disallowed page cost nothing


def test_google_news_links_are_decoded_through_the_run_fetcher_in_one_batch(settings, monkeypatch):
    import googlenewsdecoder

    from teenpehr.fetch import gnews
    from test_gnews import MODERN, MODERN_2, MODERN_ID, PUBLISHER, PUBLISHER_2, GoogleFetcher, _batch_answer, _page

    monkeypatch.setattr(gnews, "DECODE_SPACING_S", 0.0)
    monkeypatch.setattr(googlenewsdecoder, "gnewsdecoder", lambda *a, **kw: pytest.fail("library client used"))
    id2 = MODERN_2.split("/articles/")[1].split("?")[0]
    google = GoogleFetcher(
        {MODERN_ID: _page("SIG1", "111"), id2: _page("SIG2", "222")},
        answer=_batch_answer([("0", PUBLISHER), ("1", PUBLISHER_2)]),
    )
    feed = (
        '<?xml version="1.0"?><rss version="2.0"><channel><title>Google News</title>'
        f"<item><title>Monsoon session opens - Indian Express</title><link>{MODERN.replace('&', '&amp;')}</link></item>"
        f"<item><title>Gaza talks resume - Al Jazeera</title><link>{MODERN_2.replace('&', '&amp;')}</link></item>"
        "</channel></rss>"
    ).encode()

    class Both(Fetcher):
        def get(self, url, *, follow_redirects=True, **kw):
            if "news.google.com/rss/articles" in url or "news.google.com/articles" in url:
                return google.get(url, follow_redirects=follow_redirects, **kw)
            return super().get(url, **kw)

        def post(self, url, **kw):
            return google.post(url, **kw)

    f = Both({"https://news.google.com/rss/search?q=x": feed})
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    src = Source(id=5, group_id=1, name="gn", kind="gnews", url="https://news.google.com/rss/search?q=x")
    batch = c.fetch_source(src, datetime(2020, 1, 1, tzinfo=UTC))
    assert [(it.title, it.url) for it in batch.items] == [
        ("Monsoon session opens", PUBLISHER),
        ("Gaza talks resume", PUBLISHER_2),
    ]
    assert len(google.posts) == 1  # one batchexecute POST for the feed


def test_an_unparseable_feed_forgets_its_validators(settings, monkeypatch):
    from teenpehr.fetch import rss
    from teenpehr.fetch.http import Fetcher as RealFetcher

    def unreadable(data, feed_url=""):
        raise ValueError("not well-formed")

    monkeypatch.setattr(rss, "parse_feed", unreadable)
    f = RealFetcher(settings)
    _stub_sessions(f, lambda m, u: _Resp(200, {"ETag": '"v1"'}, content=b"<rss><chan", url=u))
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    batch = c.fetch_source(_src(1, "https://bad.test/rss"), datetime(2020, 1, 1, tzinfo=UTC))
    assert not batch.result.ok and batch.result.error.startswith("parse")
    f.save_state()
    assert "https://bad.test/rss" not in json.loads(f._state_file.read_text())  # the next run fetches it in full
