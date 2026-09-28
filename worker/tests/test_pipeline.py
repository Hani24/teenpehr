import json
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
import respx

from conftest import NOW, config_json, fixture_bytes
from teenpehr.api import ApiError, WorkerApi
from teenpehr.fetch.http import FetchResult
from teenpehr.llm import FakeLLM, LLMError
from teenpehr.pipeline import EditionRun, resolve_slot

BASE = "http://web.test"
ED = f"{BASE}/api/worker/editions"
KHI = ZoneInfo("Asia/Karachi")
TIMES = {"subh": "07:00", "dopahar": "13:00", "shaam": "19:30"}


# ---- slot arithmetic ---------------------------------------------------------------------------
def test_resolve_slot_picks_latest_passed_slot():
    info = resolve_slot(datetime(2026, 9, 23, 13, 5, tzinfo=KHI), TIMES)
    assert (info.date, info.slot) == ("2026-09-23", "dopahar")
    assert info.lookback_hours == 6 + 2 and not info.backfill
    assert info.since == datetime(2026, 9, 23, 5, 0, tzinfo=KHI)


def test_resolve_slot_before_first_slot_is_yesterdays_last():
    info = resolve_slot(datetime(2026, 9, 23, 6, 0, tzinfo=KHI), TIMES)
    assert (info.date, info.slot) == ("2026-09-22", "shaam")
    assert info.backfill  # 10.5 h late


def test_resolve_slot_subh_window_covers_the_night():
    info = resolve_slot(datetime(2026, 9, 23, 7, 1, tzinfo=KHI), TIMES)
    assert info.slot == "subh" and info.lookback_hours == 11.5 + 2


def test_resolve_slot_override_and_backfill():
    info = resolve_slot(datetime(2026, 9, 23, 16, 0, tzinfo=KHI), TIMES, slot="dopahar", date="2026-09-23")
    assert info.run_id == "2026-09-23-dopahar" and info.backfill
    assert info.until == datetime(2026, 9, 23, 13, 0, tzinfo=KHI)  # a backfill stops at its slot time
    info2 = resolve_slot(datetime(2026, 9, 23, 13, 30, tzinfo=KHI), TIMES, lookback_override=24)
    assert info2.lookback_hours == 24 and not info2.backfill and info2.until is None


def test_resolve_slot_refuses_a_date_without_a_slot():
    with pytest.raises(ValueError, match="needs a slot"):
        resolve_slot(datetime(2026, 9, 23, 13, 5, tzinfo=KHI), TIMES, date="2026-09-22")


# ---- fake fetcher ------------------------------------------------------------------------------
class FakeFetcher:
    def __init__(self):
        self.calls = []
        self.pages = {
            "https://jang.test/rss": fixture_bytes("rss_urdu_nodecl.xml"),
            "https://geo.test/rss": fixture_bytes("rss_geo_lying_decl.xml"),
            "https://amu.test/feed": fixture_bytes("atom.xml"),
        }

    def get(self, url, *, route="direct", headers=None, conditional=False, allow_fallback=True, max_bytes=0):
        self.calls.append((url, route))
        if url in self.pages:
            return FetchResult(url=url, status=200, content=self.pages[url], final_url=url, route_used=route, ms=12)
        if "broken.test" in url:
            return FetchResult(url=url, status=0, error="DNSError: could not resolve", route_used=route, ms=5)
        return FetchResult(url=url, status=404, error="http 404", route_used=route, ms=3)  # article bodies

    def save_state(self):
        pass


def _fake_llm(with_bad_ref=True):
    stories = [
        {
            "ref": 1,
            "refs": [1, 3],
            "posts": [5],
            "thread": "imf-review-2026-09",
            "thread_title": None,
            "title": "PM chairs meeting",
            "summary": "The PM chaired a meeting. Geo reported rain.",
            "why": "",
            "tag": "must-read",
            "coverage": "broad",
            "contested": "",
            "angles": [{"ref": 3, "note": "leads with the rain"}],
        },
        {
            "ref": 2,
            "refs": [2],
            "posts": [],
            "thread": None,
            "thread_title": "Karachi monsoon",
            "title": "Second item",
            "summary": "Short.",
            "why": "",
            "tag": "skim",
            "coverage": "single-source",
            "contested": "",
            "angles": [],
        },
    ]
    if with_bad_ref:
        stories.append(
            {
                "ref": 999,
                "refs": [999],
                "posts": [],
                "title": "Hallucinated",
                "summary": "x",
                "why": "",
                "tag": "skim",
                "coverage": "single-source",
                "contested": "",
                "angles": [],
            }
        )
    return FakeLLM(
        responses={
            "curate:pakistan": {"lead": "PM meets on IMF.", "stories": stories},
            "urdu:pakistan": {
                "lead_ur": "وزیراعظم كی آئی ایم ایف پر ملاقات",  # Arabic kaf on purpose
                "stories": [
                    {
                        "idx": 1,
                        "title_ur": "وزیراعظم كا اجلاس",
                        "summary_ur": "وزیراعظم نے اجلاس كی صدارت كی۔",
                        "angles_ur": ["بارش نمایاں"],
                    },
                    {"idx": 2, "title_ur": "دوسری خبر", "summary_ur": "مختصر۔", "thread_title_ur": "کراچی کا مون سون۔"},
                ],
                "glossary_additions": [{"term_en": "Karachi", "term_ur": "کراچی", "kind": "place"}],
            },
            "qa:pakistan": {
                "stories": [
                    {"n": 1, "status": "verified", "note": ""},
                    {"n": 2, "status": "flagged", "note": "unsupported"},
                ]
            },
            "curate:india": LLMError("curate:india: error_max_structured_output_retries"),
        }
    )


def _mock_api():
    respx.get(f"{BASE}/api/worker/health").mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.get(f"{BASE}/api/worker/config").mock(return_value=httpx.Response(200, text=config_json()))
    runs = respx.post(f"{BASE}/api/worker/runs").mock(return_value=httpx.Response(201, json={"id": 42}))
    fin = respx.patch(f"{BASE}/api/worker/runs/42").mock(return_value=httpx.Response(200, json={}))

    def items_cb(request):
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "items": [
                    {"url_canonical": it["url_canonical"], "id": 9000 + n, "is_new": n != 2}
                    for n, it in enumerate(body["items"], 1)
                ]
            },
        )

    items = respx.post(f"{BASE}/api/worker/items").mock(side_effect=items_cb)
    respx.get(f"{BASE}/api/worker/posts").mock(
        return_value=httpx.Response(
            200,
            json={
                "posts": [
                    {
                        "id": 501,
                        "handle_id": 5,
                        "author_handle": "HamidMirPAK",
                        "author_name": "Hamid Mir",
                        "text": "Breaking: meeting underway",
                        "url": "https://x.com/HamidMirPAK/status/1",
                        "posted_at": "2026-09-23T07:30:00+00:00",
                    }
                ]
            },
        )
    )
    put = respx.put(f"{BASE}/api/worker/editions/2026-09-23/dopahar").mock(
        return_value=httpx.Response(200, json={"edition_id": 7, "status": "draft", "stories": []})
    )
    pub = respx.post(f"{BASE}/api/worker/editions/2026-09-23/dopahar/publish").mock(
        return_value=httpx.Response(200, json={"status": "published", "url": "/en/2026-09-23/dopahar"})
    )
    glos = respx.post(f"{BASE}/api/worker/glossary").mock(
        return_value=httpx.Response(200, json={"added": 1, "skipped": 0})
    )
    respx.get(f"{ED}/2026-09-23/dopahar").mock(return_value=httpx.Response(404, json={"error": "not found"}))
    return runs, fin, items, put, pub, glos


@respx.mock
def test_dry_run_writes_file_and_makes_no_writes(settings, tmp_path: Path):
    runs, fin, items, put, pub, glos = _mock_api()
    api = WorkerApi(BASE, "tok", backoff=0)
    run = EditionRun(settings, api, _fake_llm(), FakeFetcher(), dry_run=True, now=NOW.astimezone(KHI))
    report = run.run()
    assert report.status == "dry-run" and report.out_file
    assert (
        not runs.called
        and not items.called
        and not put.called
        and not pub.called
        and not fin.called
        and not glos.called
    )
    out = json.loads(Path(report.out_file).read_text(encoding="utf-8"))
    assert out["run_id"] == "2026-09-23-dopahar"
    groups = {g["group"]: g for g in out["edition"]["groups"]}
    assert set(groups) == {"pakistan", "india"}
    # pakistan: the hallucinated story (ref 999) was dropped, two remain
    pk = groups["pakistan"]["stories"]
    assert [s["title_en"] for s in pk] == ["PM chairs meeting", "Second item"]
    assert "unknown refs [999]" in " ".join(out["groups"]["pakistan"]["errors"])
    # india: LLM failed → headline fallback, skim, no Urdu
    assert out["groups"]["india"]["fallback"] is True
    assert all(s["tag"] == "skim" and s["title_ur"] == "" for s in groups["india"]["stories"])


@respx.mock
def test_live_run_puts_publishes_and_validates(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    api = WorkerApi(BASE, "tok", backoff=0)
    fetcher = FakeFetcher()
    run = EditionRun(settings, api, _fake_llm(), fetcher, dry_run=False, now=NOW.astimezone(KHI))
    report = run.run()
    assert report.status == "ok" and report.edition_id == 7 and report.publish_status == "published"
    assert runs.called and items.called and put.called and pub.called and glos.called
    body = json.loads(put.calls[0].request.content)
    pk = next(g for g in body["groups"] if g["group"] == "pakistan")
    assert pk["lead_en"] == "PM meets on IMF." and pk["lead_ur"].startswith("وزیراعظم کی")  # kaf normalised
    s1 = pk["stories"][0]
    assert s1["thread"] == "imf-review-2026-09" and s1["qa_status"] == "verified"
    assert s1["title_ur"] == "وزیراعظم کا اجلاس" and s1["angles"][0]["note_ur"] == "بارش نمایاں"
    ids = {r["item_id"] for r in s1["sources"]}
    assert len(ids) == 2 and s1["posts"] == [501]
    assert sum(1 for r in s1["sources"] if r["is_primary"]) == 1
    # the existing thread has no Urdu title yet, so its English title goes to the Urdu pass
    assert s1["thread_title_en"] == "IMF review" and s1["thread_title_ur"] == ""
    s2 = pk["stories"][1]
    assert (
        s2["thread"] == "karachi-monsoon-2026-09"
        and s2["thread_title_en"] == "Karachi monsoon"
        and s2["thread_title_ur"] == "کراچی کا مون سون"  # the thread's own Urdu title, not the story headline
        and s2["qa_status"] == "flagged"
    )
    assert body["partial"] is False
    # india: curation failed → raw headlines, all flagged so the edition cannot publish unchecked
    india = next(g for g in body["groups"] if g["group"] == "india")
    assert india["stories"] and all(
        st["qa_status"] == "flagged" and "headline fallback" in st["qa_note"] for st in india["stories"]
    )
    # the old Geo item (21 Sep) is outside the window; broken source reported as failed
    fin_body = json.loads(fin.calls[0].request.content)
    assert fin_body["status"] == "ok" and fin_body["cost_usd"] > 0
    by_src = {r["source_id"]: r for r in fin_body["sources"]}
    assert by_src[13]["ok"] is False and by_src[10]["items"] == 2 and by_src[11]["items"] == 2
    assert by_src[12]["route"] == "germany"
    pub_body = json.loads(pub.calls[0].request.content)
    assert pub_body == {"force": False, "notify": True}
    assert json.loads(glos.calls[0].request.content)["entries"][0]["term_en"] == "Karachi"


@respx.mock
def test_failure_marks_run_failed(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    put.mock(return_value=httpx.Response(400, json={"error": "invalid", "issues": []}))
    api = WorkerApi(BASE, "tok", backoff=0)
    run = EditionRun(settings, api, _fake_llm(), FakeFetcher(), dry_run=False, now=NOW.astimezone(KHI))
    with pytest.raises(ApiError):
        run.run()
    assert json.loads(fin.calls[-1].request.content)["status"] == "failed"
    assert not pub.called


@respx.mock
def test_empty_when_nothing_fetched(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    fetcher = FakeFetcher()
    fetcher.pages = {}
    api = WorkerApi(BASE, "tok", backoff=0)
    report = EditionRun(settings, api, _fake_llm(), fetcher, dry_run=False, now=NOW.astimezone(KHI)).run()
    assert report.status == "empty" and not put.called
    assert json.loads(fin.calls[0].request.content)["status"] == "empty"


def test_now_default_is_karachi(settings):
    run = EditionRun(settings, WorkerApi(BASE, "tok"), FakeLLM(), FakeFetcher())
    assert run.now.tzinfo is not None and run.now.utcoffset().total_seconds() == 5 * 3600
    assert datetime.now(UTC) - run.now.astimezone(UTC) < __import__("datetime").timedelta(seconds=5)


# ---- delivery failure → saved file → resubmit -------------------------------------------------
@respx.mock
def test_delivery_failure_saves_edition_and_resubmit_replays_it(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    put.mock(return_value=httpx.Response(503, text="down"))  # every attempt fails
    api = WorkerApi(BASE, "tok", backoff=0)
    run = EditionRun(settings, api, _fake_llm(), FakeFetcher(), dry_run=False, now=NOW.astimezone(KHI))
    with pytest.raises(ApiError):
        run.run()
    assert not pub.called
    saved = settings.out_dir / "failed-2026-09-23-dopahar.json"
    assert saved.exists()
    data = json.loads(saved.read_text(encoding="utf-8"))
    assert data["date"] == "2026-09-23" and data["slot"] == "dopahar" and data["db_run_id"] == 42
    assert data["edition"] == json.loads(put.calls[0].request.content)  # exactly what was sent
    assert data["passes"]["curate"]["calls"] == 1 and data["cost_usd"] > 0
    assert json.loads(fin.calls[-1].request.content)["status"] == "failed"

    # now the web app is back: resubmit without any Claude call
    from teenpehr.pipeline import resubmit

    put.mock(return_value=httpx.Response(200, json={"edition_id": 7, "status": "draft", "stories": []}))
    llm_calls_before = 0
    result = resubmit(api, saved, publish=True)
    assert result["put"] == "draft" and result["publish"] == "published" and result["edition_id"] == 7
    assert json.loads(put.calls[-1].request.content) == data["edition"]
    assert json.loads(pub.calls[0].request.content) == {"force": False, "notify": True}
    assert json.loads(glos.calls[0].request.content)["entries"][0]["term_en"] == "Karachi"
    assert not saved.exists() and (settings.out_dir / "resubmitted-2026-09-23-dopahar.json").exists()
    assert llm_calls_before == 0


@respx.mock
def test_resubmit_no_publish_and_409(settings, tmp_path):
    from teenpehr.pipeline import resubmit

    f = tmp_path / "failed-2026-09-23-subh.json"
    payload = {
        "run_id": "2026-09-23-subh",
        "date": "2026-09-23",
        "slot": "subh",
        "db_run_id": 1,
        "backfill": True,
        "edition": {
            "run_id": 1,
            "status": "draft",
            "groups": [
                {
                    "group": "pakistan",
                    "stories": [
                        {
                            "order": 0,
                            "title_en": "T",
                            "summary_en": "S",
                            "sources": [{"item_id": 9001, "is_primary": True}],
                        }
                    ],
                }
            ],
        },
        "glossary_additions": [],
    }
    f.write_text(json.dumps(payload))
    respx.get(f"{ED}/2026-09-23/subh").mock(return_value=httpx.Response(404, json={"error": "not found"}))
    put = respx.put(f"{BASE}/api/worker/editions/2026-09-23/subh").mock(
        return_value=httpx.Response(409, json={"error": "edition is published"})
    )
    pub = respx.post(f"{BASE}/api/worker/editions/2026-09-23/subh/publish").mock(
        return_value=httpx.Response(200, json={"status": "published"})
    )
    api = WorkerApi(BASE, "tok", backoff=0)
    r = resubmit(api, f, publish=False)
    assert r["put"] == "already-published" and r["publish"] is None and not pub.called and put.called
    assert (tmp_path / "resubmitted-2026-09-23-subh.json").exists()


def test_resubmit_refuses_dry_run_placeholder_ids(settings, tmp_path):
    from teenpehr.pipeline import resubmit

    f = tmp_path / "failed-x.json"
    f.write_text(
        json.dumps(
            {
                "run_id": "x",
                "date": "2026-09-23",
                "slot": "subh",
                "edition": {
                    "groups": [
                        {
                            "group": "g",
                            "stories": [{"order": 0, "title_en": "T", "summary_en": "S", "sources": [{"item_id": -1}]}],
                        }
                    ]
                },
            }
        )
    )
    with pytest.raises(ValueError):
        resubmit(WorkerApi(BASE, "tok"), f)
    assert f.exists()


@respx.mock
def test_report_has_per_pass_totals(settings):
    _mock_api()
    api = WorkerApi(BASE, "tok", backoff=0)
    report = EditionRun(settings, api, _fake_llm(), FakeFetcher(), dry_run=False, now=NOW.astimezone(KHI)).run()
    # pakistan: curate + urdu + qa; india: curate failed → no urdu/qa
    assert (
        report.passes["curate"]["calls"] == 1
        and report.passes["urdu"]["calls"] == 1
        and report.passes["qa"]["calls"] == 1
    )
    assert report.tokens_in == 3000 and report.tokens_out == 600  # 3 fake calls × (1000 in, 200 out), a plain sum
    assert (
        report.passes["curate"]["uncached"]
        + report.passes["curate"]["cache_read"]
        + report.passes["curate"]["cache_write"]
        == 1000
    )


def _saved(tmp_path, slot="subh"):
    f = tmp_path / f"failed-2026-09-23-{slot}.json"
    edition = {
        "groups": [
            {
                "group": "pakistan",
                "stories": [{"order": 0, "title_en": "T", "summary_en": "S", "sources": [{"item_id": 9001}]}],
            }
        ]
    }
    f.write_text(json.dumps({"run_id": f"2026-09-23-{slot}", "date": "2026-09-23", "slot": slot, "edition": edition}))
    return f


@respx.mock
def test_resubmit_refuses_an_edition_held_for_review(tmp_path):
    from teenpehr.pipeline import resubmit

    respx.get(f"{ED}/2026-09-23/subh").mock(
        return_value=httpx.Response(200, json={"edition_id": 7, "status": "review"})
    )
    put = respx.put(f"{ED}/2026-09-23/subh").mock(return_value=httpx.Response(200, json={}))
    pub = respx.post(f"{ED}/2026-09-23/subh/publish").mock(
        return_value=httpx.Response(200, json={"status": "published"})
    )
    f = _saved(tmp_path)
    with pytest.raises(ValueError, match="held for review"):
        resubmit(WorkerApi(BASE, "tok", backoff=0), f)
    assert not put.called and not pub.called and f.exists()


@respx.mock
def test_resubmit_of_a_published_edition_skips_the_put(tmp_path):
    from teenpehr.pipeline import resubmit

    respx.get(f"{ED}/2026-09-23/subh").mock(
        return_value=httpx.Response(200, json={"edition_id": 7, "status": "published"})
    )
    put = respx.put(f"{ED}/2026-09-23/subh").mock(return_value=httpx.Response(200, json={}))
    respx.post(f"{ED}/2026-09-23/subh/publish").mock(return_value=httpx.Response(200, json={"status": "published"}))
    r = resubmit(WorkerApi(BASE, "tok", backoff=0), _saved(tmp_path))
    assert r["put"] == "already-published" and r["publish"] == "published" and not put.called
