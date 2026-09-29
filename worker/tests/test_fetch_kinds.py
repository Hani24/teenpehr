import json
from datetime import UTC, datetime
from types import SimpleNamespace

from conftest import fixture_bytes
from teenpehr.fetch import gdelt, kinds
from teenpehr.fetch.http import FetchResult
from teenpehr.models import Source
from teenpehr.pipeline import Collector
from test_fetch_sitemap import INDEX, NEWS


class Fetcher:
    def __init__(self, pages: dict[str, bytes], status: dict[str, int] | None = None):
        self.pages = pages
        self.status = status or {}
        self.calls: list[tuple[str, dict]] = []
        self.forgotten: list[str] = []

    def get(self, url, **kw):
        self.calls.append((url, kw))
        if url in self.status:
            return FetchResult(url=url, status=self.status[url], error=f"http {self.status[url]}", ms=2)
        if url in self.pages:
            return FetchResult(url=url, status=200, content=self.pages[url], final_url=url, ms=5)
        return FetchResult(url=url, status=404, error="http 404", ms=1)

    def forget(self, url):
        self.forgotten.append(url)

    def save_state(self):
        pass


def src(kind, url):
    return SimpleNamespace(kind=kind, url=url, route="direct")


def allow_all(url, route):
    return True


def test_feeds_are_fetched_as_before_without_robots():
    url = "https://amu.test/feed"
    f = Fetcher({url: fixture_bytes("atom.xml")})
    asked: list[str] = []
    feed = kinds.read(f, src("rss", url), conditional=True, allowed=lambda u, r: asked.append(u) or False)
    assert [e.link for e in feed.entries] == ["https://amu.tv/1", "https://amu.tv/2"]
    assert f.calls == [(url, {"route": "direct", "conditional": True})]
    assert asked == []  # feeds are feeds: robots.txt is not a gate for them


def test_youtube_links_become_watch_links():
    url = "https://www.youtube.com/feeds/videos.xml?channel_id=x"
    feed = kinds.read(Fetcher({url: fixture_bytes("youtube.xml")}), src("youtube", url))
    assert feed.entries[0].link == "https://www.youtube.com/watch?v=abc"


def test_unfetched_kinds_make_no_request():
    f = Fetcher({})
    for kind in ("telegram", "html", "manual"):
        feed = kinds.read(f, src(kind, "https://t.me/s/x"))
        assert feed.entries is None and "not fetched" in (feed.res.error or "")
    assert f.calls == []


def test_sitemap_is_read_only_where_robots_allows_it():
    url = "https://www.example.pk/sitemap-news.xml"
    f = Fetcher({url: NEWS})
    feed = kinds.read(f, src("sitemap", url), allowed=lambda u, r: False)
    assert feed.entries is None and feed.res.error.startswith("robots.txt") and f.calls == []
    feed = kinds.read(f, src("sitemap", url), conditional=True, allowed=allow_all)
    assert [e.title for e in feed.entries] == ["وزیراعظم کا اجلاس", "Older headline & more"]
    assert f.calls[0][1]["conditional"] is True


def test_sitemap_index_reads_its_two_newest_children_in_full():
    idx = "https://www.example.pk/sitemap-index.xml"
    child3 = "https://www.example.pk/sitemap-news-3.xml"
    child2 = "https://www.example.pk/sitemap-news-2.xml"
    other = NEWS.replace(b"older-story", b"third-story").replace(b"Older headline", b"Third headline")
    f = Fetcher({idx: INDEX, child3: NEWS, child2: other})
    feed = kinds.read(f, src("sitemap", idx), conditional=True, allowed=allow_all)
    assert [u for u, _ in f.calls] == [idx, child3, child2]  # sitemap-news-1 (oldest) is not read
    assert "conditional" not in f.calls[1][1]  # children in full
    assert f.forgotten == [idx]  # an index's validators would hide its children's changes
    assert {e.link.rsplit("/", 1)[1] for e in feed.entries} == {"newer-story", "older-story", "third-story"}
    assert feed.res.ok and feed.res.ms == 15


def test_sitemap_index_whose_children_fail_reports_the_failure():
    idx = "https://www.example.pk/sitemap-index.xml"
    f = Fetcher({idx: INDEX}, status={"https://www.example.pk/sitemap-news-3.xml": 503})
    feed = kinds.read(f, src("sitemap", idx), allowed=allow_all)
    assert feed.entries is None and feed.res.status == 503


def test_gdelt_goes_through_the_slot_and_robots(monkeypatch):
    url = gdelt.api_url("pakistan")
    body = json.dumps({"articles": [{"url": "https://a.pk/1", "title": "T", "seendate": "20260929T031500Z"}]})
    f = Fetcher({url: body.encode()})
    slots: list[int] = []
    real = gdelt.slot

    def counting(spacing_s=None):
        slots.append(1)
        return real(0.0)

    monkeypatch.setattr(gdelt, "slot", counting)
    feed = kinds.read(f, src("gdelt", url), allowed=allow_all)
    assert [e.link for e in feed.entries] == ["https://a.pk/1"]
    assert len(slots) == 2  # robots.txt and the request each take a slot
    assert f.calls[0][1] == {"route": "direct", "allow_fallback": False}


def test_gdelt_text_error_is_a_parse_error(monkeypatch):
    url = gdelt.api_url("x")
    monkeypatch.setattr(gdelt, "SPACING_S", 0.0)
    feed = kinds.read(Fetcher({url: b"Please limit requests to one every 5 seconds"}), src("gdelt", url))
    assert feed.entries is None and "GDELT said" in feed.error


def test_interleave_by_host_spreads_one_hosts_urls():
    urls = ["https://y.test/1", "https://y.test/2", "https://y.test/3", "https://a.test/1", "https://b.test/1"]
    assert kinds.interleave_by_host(urls) == [0, 3, 4, 1, 2]
    assert kinds.interleave_by_host([]) == []


def test_collector_reads_sitemap_and_gdelt_sources(settings, monkeypatch):
    monkeypatch.setattr(gdelt, "SPACING_S", 0.0)
    sm_url = "https://www.example.pk/sitemap-news.xml"
    gd_url = gdelt.api_url("pakistan")
    body = json.dumps(
        {
            "articles": [
                {
                    "url": "https://www.samaa.tv/news/1",
                    "title": "Cabinet approves plan",
                    "seendate": "20260929T031500Z",
                    "domain": "samaa.tv",
                    "socialimage": "https://www.samaa.tv/i.jpg",
                }
            ]
        }
    )
    pages = {sm_url: NEWS, gd_url: body.encode()}
    f = Fetcher(pages)
    c = Collector(settings, f, now=datetime(2026, 9, 29, 6, tzinfo=UTC))
    monkeypatch.setattr(c.articles, "allowed", lambda url, route="direct": True)
    sources = [
        Source(id=1, group_id=1, name="Example (sitemap)", kind="sitemap", url=sm_url, lang="en"),
        Source(id=2, group_id=1, name="Samaa via GDELT", kind="gdelt", url=gd_url, lang="en"),
        Source(id=3, group_id=1, name="Channel", kind="telegram", url="https://t.me/s/x"),
    ]
    batches = c.collect(sources, datetime(2026, 9, 27, tzinfo=UTC))
    assert [b.source.id for b in batches] == [1, 2]  # telegram is skipped, order kept
    sm, gd = batches
    assert sm.result.ok and [it.title for it in sm.items] == ["وزیراعظم کا اجلاس", "Older headline & more"]
    assert sm.items[0].fetch.via == "sitemap" and sm.items[0].site_name == "Example Times"
    assert sm.items[0].image_url == "https://cdn.example.pk/img/1.jpg"
    assert gd.result.ok and gd.items[0].url == "https://www.samaa.tv/news/1"
    assert gd.items[0].site_name == "samaa.tv" and gd.items[0].fetch.via == "gdelt"
    assert gd.items[0].description is None


def test_sitemap_fragment_picks_sections_and_is_part_of_the_source_url():
    base = "https://www.example.pk/sitemap-news.xml"
    url = base + "#include=/news/,/world/&exclude=older"
    f = Fetcher({url: NEWS})  # the fetcher is asked for the URL as configured; curl never sends the fragment
    feed = kinds.read(f, src("sitemap", url), allowed=allow_all)
    assert [e.link for e in feed.entries] == ["https://www.example.pk/news/newer-story"]
    assert kinds.PathFilter.of(base) == kinds.PathFilter() and not kinds.PathFilter.of(base)
    assert kinds.PathFilter.of(base + "#include=%2FWorld%2F").include == ("/world/",)


def test_round_robin_gives_every_feed_a_turn_before_the_cap():
    from teenpehr.pipeline import round_robin

    feeds = [["a1", "a2", "a3"], [], ["b1"], ["c1", "c2"]]
    assert round_robin(feeds) == ["a1", "b1", "c1", "a2", "c2", "a3"]
    assert round_robin([]) == [] and round_robin([[], []]) == []
    # a cap of 3 keeps one item of each non-empty feed instead of the first feed's three
    assert round_robin(feeds)[:3] == ["a1", "b1", "c1"]


def test_a_429_on_robots_txt_is_a_rate_limit_not_a_refusal(monkeypatch):
    monkeypatch.setattr(gdelt, "SPACING_S", 0.0)

    class Cooling(Fetcher):
        cooling = 0.0

        def cooldown_left(self, url):
            return self.cooling

    def robots_answered_429(url, route):  # ArticleFetcher: robots.txt unreadable, so nothing is allowed
        f.cooling = 900.0  # ...and the Fetcher put the host on its 429 cooldown
        return False

    for kind, url in (("sitemap", "https://www.example.pk/sitemap-news.xml"), ("gdelt", gdelt.api_url("x"))):
        f = Cooling({})
        feed = kinds.read(f, src(kind, url), allowed=robots_answered_429)
        assert feed.res.rate_limited and feed.res.status == 429 and f.calls == []
    f = Cooling({})
    feed = kinds.read(f, src("sitemap", "https://www.example.pk/s.xml"), allowed=lambda u, r: False)
    assert not feed.res.rate_limited and feed.res.error.startswith("robots.txt disallows")


def test_sitemap_keeps_only_the_publishers_own_site():
    from teenpehr.fetch import sitemap

    assert sitemap.site_of("https://www.dawn.com/news/1") == "dawn.com"
    assert sitemap.site_of("https://epaper.dawn.com/x") == "dawn.com"
    assert sitemap.site_of("https://dunya.com.pk/index.php/pakistan/1") == "dunya.com.pk"
    assert sitemap.site_of("https://feeds.bbci.co.uk/x") == "bbci.co.uk"
    assert sitemap.site_of("https://rfa.org/arc/x") == sitemap.site_of("https://www.rfa.org/english/y")

    url = "https://www.example.pk/sitemap-news.xml"
    mixed = NEWS.replace(b"https://www.example.pk/news/older-story", b"https://elsewhere.test/news/older-story")
    feed = kinds.read(Fetcher({url: mixed}), src("sitemap", url), allowed=allow_all)
    # another site's article is never cited under this publisher's name
    assert [e.link for e in feed.entries] == ["https://www.example.pk/news/newer-story"]

    only_other = mixed.replace(b"<loc>/news/newer-story", b"<loc>https://elsewhere.test/news/newer-story")
    feed = kinds.read(Fetcher({url: only_other}), src("sitemap", url), allowed=allow_all)
    assert not feed.entries and "other sites" in feed.error  # an error the collector and the audit report

    idx = "https://www.example.pk/sitemap-index.xml"
    foreign = INDEX.replace(b"https://www.example.pk/sitemap-news-3.xml", b"https://elsewhere.test/sitemap-news-3.xml")
    child2 = "https://www.example.pk/sitemap-news-2.xml"
    f = Fetcher({idx: foreign, child2: NEWS})
    feed = kinds.read(f, src("sitemap", idx), allowed=allow_all)
    assert "https://elsewhere.test/sitemap-news-3.xml" not in [u for u, _ in f.calls]  # a third party is never fetched
    assert [u for u, _ in f.calls][:2] == [idx, child2] and len(feed.entries) == 2

    all_foreign = INDEX.replace(b"https://www.example.pk/", b"https://elsewhere.test/")
    f = Fetcher({idx: all_foreign})
    feed = kinds.read(f, src("sitemap", idx), allowed=allow_all)
    assert feed.entries is None and "own site" in feed.error and [u for u, _ in f.calls] == [idx]
