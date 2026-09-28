"""Collection in a run: feeds that answer 304, when conditional-GET validators are saved, dedupe per
group, and the upper end of a backfill's window."""

import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
import respx

from conftest import fixture_bytes
from teenpehr.api import ApiError, WorkerApi
from teenpehr.fetch.http import FetchResult
from teenpehr.models import Source
from teenpehr.pipeline import Collector, EditionRun
from test_pipeline import BASE, KHI, NOW, FakeFetcher, _fake_llm, _mock_api

JANG = "https://jang.test/rss"


class Fetcher304(FakeFetcher):
    """FakeFetcher whose listed feeds answer 304 Not Modified; counts save_state calls."""

    def __init__(self, unchanged=(JANG,)):
        super().__init__()
        self.unchanged = set(unchanged)
        self.saved = 0

    def get(self, url, **kw):
        if url in self.unchanged:
            self.calls.append((url, kw.get("route", "direct")))
            return FetchResult(url=url, status=304, not_modified=True, route_used="direct", ms=4)
        return super().get(url, **kw)

    def save_state(self):
        self.saved += 1


STORED = [  # what GET /items?group=pakistan returns: Jang's items from an earlier run, plus others
    {
        "id": 8001,
        "source_id": 10,
        "url": "https://jang.com.pk/news/1",
        "title": "وزیراعظم کا اسلام آباد میں اہم اجلاس",
        "text": "وزیراعظم شہباز شریف نے آج اجلاس کی صدارت کی۔ " * 10,
        "published_at": "2026-09-23T03:00:00+00:00",
        "lang": "ur",
    },
    {
        "id": 8002,
        "source_id": 10,
        "url": "https://jang.com.pk/news/0",
        "title": "Yesterday's Jang story",
        "text": "",
        "published_at": "2026-09-22T03:00:00+00:00",  # before the window
        "lang": "ur",
    },
    {
        "id": 8003,
        "source_id": 11,  # Geo's, not Jang's
        "url": "https://www.geo.tv/latest/9-other",
        "title": "Geo stored item",
        "text": "",
        "published_at": "2026-09-23T03:00:00+00:00",
        "lang": "en",
    },
]


def _stored_items():
    return respx.get(f"{BASE}/api/worker/items").mock(return_value=httpx.Response(200, json={"items": STORED}))


def _run(settings, fetcher, *, dry_run, llm=None):
    api = WorkerApi(BASE, "tok", backoff=0)
    return EditionRun(settings, api, llm or _fake_llm(), fetcher, dry_run=dry_run, now=NOW.astimezone(KHI))


# ---- 304 feeds (#0) ----------------------------------------------------------------------------
@respx.mock
def test_unchanged_feed_contributes_its_stored_items(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    stored = _stored_items()
    fetcher = Fetcher304()
    report = _run(settings, fetcher, dry_run=False).run()
    assert report.status == "ok"
    assert stored.call_count == 1 and stored.calls[0].request.url.params["group"] == "pakistan"
    posted = [it["url_canonical"] for it in json.loads(items.calls[0].request.content)["items"]]
    assert "jang.com.pk/news/1" in posted  # recovered, inside the window
    assert "jang.com.pk/news/0" not in posted and "geo.tv/latest/9-other" not in posted  # old / another source's
    by_src = {r["source_id"]: r for r in json.loads(fin.calls[0].request.content)["sources"]}
    assert by_src[10]["ok"] is True and by_src[10]["items"] == 1
    assert fetcher.saved == 1  # validators saved once the items were stored


@respx.mock
def test_dry_run_reads_unchanged_feeds_back_but_never_saves_validators(settings):
    _mock_api()
    _stored_items()
    fetcher = Fetcher304()
    report = _run(settings, fetcher, dry_run=True).run()
    assert fetcher.saved == 0
    out = json.loads(Path(report.out_file).read_text(encoding="utf-8"))
    pk_input = out["groups"]["pakistan"]["input"]
    line = next(x for x in pk_input.splitlines() if "اسلام آباد" in x)
    assert "(seen before)" in line  # stored by an earlier run


@respx.mock
def test_validators_are_not_saved_when_the_items_could_not_be_stored(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    items.mock(return_value=httpx.Response(400, json={"error": "unknown source ids: 10"}))
    fetcher = Fetcher304(unchanged=())
    with pytest.raises(ApiError):
        _run(settings, fetcher, dry_run=False).run()
    assert fetcher.saved == 0  # the next run fetches the feeds in full again


# ---- dedupe per group (#11) --------------------------------------------------------------------
@respx.mock
def test_an_article_in_two_groups_feeds_reaches_both_groups(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    fetcher = FakeFetcher()
    fetcher.pages["https://amu.test/feed"] = fetcher.pages["https://geo.test/rss"]  # India carries Geo's feed
    report = _run(settings, fetcher, dry_run=True).run()
    out = json.loads(Path(report.out_file).read_text(encoding="utf-8"))
    assert "Geo item two" in out["groups"]["pakistan"]["input"]
    assert "Geo item two" in out["groups"]["india"]["input"]

    _run(settings, fetcher, dry_run=False).run()
    sent = [(it["source_id"], it["url_canonical"]) for it in json.loads(items.calls[0].request.content)["items"]]
    assert len(sent) == len(set(sent))  # each feed's sighting once; the server stores one row per article
    assert {c for s, c in sent if s == 11} & {c for s, c in sent if s == 12}  # both feeds of the shared one
    pk = next(g for g in json.loads(put.calls[0].request.content)["groups"] if g["group"] == "pakistan")
    assert pk["stories"]


def test_dedupe_still_applies_inside_a_group(settings):
    f = FakeFetcher()
    f.pages["https://geo2.test/rss"] = f.pages["https://geo.test/rss"]
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    srcs = [
        Source(id=1, group_id=1, name="a", url="https://geo.test/rss"),
        Source(id=2, group_id=1, name="b", url="https://geo2.test/rss"),
    ]
    batches = c.collect(srcs, datetime(2026, 9, 22, tzinfo=UTC))
    assert sum(len(b.items) for b in batches) == 2
    # The feed that lost each article keeps its own copy as a sighting (never in the numbered lists).
    kept = {(it.source_id, it.url_canonical) for b in batches for it in b.items}
    seen = {(it.source_id, it.url_canonical) for b in batches for it in b.also_seen}
    assert len(seen) == 2 and not kept & seen
    assert {c for _, c in kept} == {c for _, c in seen}


@respx.mock
def test_a_feed_that_loses_an_article_in_its_group_still_sends_its_sighting(settings):
    """Each feed's copy reaches the API, so an item's own feed is compared for revisions on every run."""
    runs, fin, items, put, pub, glos = _mock_api()
    fetcher = FakeFetcher()
    fetcher.pages["https://jang.test/rss"] = fetcher.pages["https://geo.test/rss"]  # both Pakistan feeds carry Geo's
    _run(settings, fetcher, dry_run=False).run()
    sent = [(it["source_id"], it["url_canonical"]) for it in json.loads(items.calls[0].request.content)["items"]]
    assert len(sent) == len(set(sent))
    jang, geo = {c for s, c in sent if s == 10}, {c for s, c in sent if s == 11}
    assert jang and jang == geo


def test_a_same_title_article_at_another_url_is_not_a_sighting(settings):
    f = FakeFetcher()
    other = f.pages["https://geo.test/rss"].replace(b"https://www.geo.tv/", b"https://mirror.test/")
    assert other != f.pages["https://geo.test/rss"]
    f.pages["https://geo2.test/rss"] = other
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    srcs = [
        Source(id=1, group_id=1, name="a", url="https://geo.test/rss"),
        Source(id=2, group_id=1, name="b", url="https://geo2.test/rss"),
    ]
    batches = c.collect(srcs, datetime(2026, 9, 22, tzinfo=UTC))
    assert sum(len(b.items) for b in batches) == 2  # deduped by title for the editor
    assert not [it for b in batches for it in b.also_seen]  # but a different URL is a different item


# ---- the backfill window's upper end (#10) -----------------------------------------------------
def test_backfill_window_stops_at_the_slot_time(settings):
    f = FakeFetcher()
    f.pages["https://undated.test/rss"] = fixture_bytes("rss_undated.xml")
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    geo = Source(id=1, group_id=1, name="geo", url="https://geo.test/rss")
    since = datetime(2026, 9, 23, 0, 0, tzinfo=UTC)
    until = datetime(2026, 9, 23, 3, 0, tzinfo=UTC)  # 08:00 Karachi
    titles = [it.title for it in c.fetch_source(geo, since, until).items]
    assert titles == ["Geo item two"]  # 09:15 Karachi is after the slot; 06:00 is inside
    undated = Source(id=2, group_id=2, name="u", url="https://undated.test/rss")
    assert c.fetch_source(undated, since, until).items == []  # undated entries cannot be placed in a past window
    assert len(c.fetch_source(Source(id=3, group_id=3, name="u", url="https://undated.test/rss"), since).items) == 2
