"""Follow-ups from reviewing the run fixes: a backfill must not record feed validators, failed Claude
calls count towards spend, the catch-up check never fails a finished run, thread titles fit the API,
and a --groups draft stays a draft through `teenpehr resubmit`."""

import json
from datetime import UTC, datetime

import httpx
import pytest
import respx

from conftest import config_json
from teenpehr.api import ApiError, WorkerApi
from teenpehr.fetch.http import FetchResult
from teenpehr.llm import LLMError
from teenpehr.models import CurateOut, Group, Source, UrduOut
from teenpehr.pipeline import Collector, EditionRun, GroupWork, apply_urdu, curation_to_stories, resubmit, run_editions
from teenpehr.render import NumberedItem
from test_pipeline import BASE, ED, KHI, NOW, FakeFetcher, _fake_llm, _mock_api

GEO = "https://geo.test/rss"


class ValidatorFetcher(FakeFetcher):
    """Keeps conditional-GET validators like the real Fetcher: recorded on a conditional 200, and a
    conditional request for a URL that has them answers 304 (the fixture feeds never change)."""

    def __init__(self):
        super().__init__()
        self.validators: set[str] = set()

    def get(self, url, *, conditional=False, **kw):
        if conditional and url in self.validators:
            self.calls.append((url, kw.get("route", "direct")))
            return FetchResult(url=url, status=304, not_modified=True, route_used="direct", ms=4)
        res = super().get(url, conditional=conditional, **kw)
        if res.ok and conditional:
            self.validators.add(url)
        return res


# ---- a backfill leaves the validators alone -----------------------------------------------------
def test_backfill_fetches_in_full_and_records_no_validators(settings):
    f = ValidatorFetcher()
    geo = Source(id=1, group_id=1, name="geo", url=GEO)
    since = datetime(2026, 9, 23, 0, 0, tzinfo=UTC)
    until = datetime(2026, 9, 23, 3, 0, tzinfo=UTC)  # 08:00 Karachi
    backfill = Collector(settings, f, now=datetime(2026, 9, 23, 9, tzinfo=UTC)).fetch_source(geo, since, until)
    assert [it.title for it in backfill.items] == ["Geo item two"]
    assert f.validators == set()
    # The next on-time run still gets the feed in full, including the entry after the backfill's slot
    # time that the backfill did not store (a 304 there would hide it: nothing on the server has it).
    on_time = Collector(settings, f, now=datetime(2026, 9, 23, 9, tzinfo=UTC)).fetch_source(geo, since)
    assert not on_time.not_modified and len(on_time.items) > len(backfill.items)
    assert f.validators == {GEO}


# ---- failed Claude calls are billed ------------------------------------------------------------
@respx.mock
def test_a_failed_claude_call_counts_towards_spend(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    llm = _fake_llm()
    llm.responses["qa:pakistan"] = LLMError("qa:pakistan: error_max_budget_usd", cost_usd=0.05)
    api = WorkerApi(BASE, "tok", backoff=0)
    report = EditionRun(settings, api, llm, FakeFetcher(), dry_run=False, now=NOW.astimezone(KHI)).run()
    # curate + urdu for pakistan at $0.01 each, plus the failed QA call's $0.05 (india's failure has none)
    assert report.cost_usd == pytest.approx(0.07) and report.passes["qa"]["cost_usd"] == pytest.approx(0.05)
    assert json.loads(fin.calls[-1].request.content)["cost_usd"] == pytest.approx(0.07)
    spent = json.loads((settings.state_dir / "spend-2026-09-23.json").read_text())["usd"]
    assert spent == pytest.approx(0.07)


async def test_claude_llm_error_carries_the_cost_of_the_failed_call(monkeypatch):
    import claude_agent_sdk

    from teenpehr.llm import ClaudeLLM
    from teenpehr.models import QaOut

    async def fake_query(*, prompt, options):
        yield claude_agent_sdk.ResultMessage(
            subtype="error_max_budget_usd",
            duration_ms=1,
            duration_api_ms=1,
            is_error=True,
            num_turns=2,
            session_id="s",
            total_cost_usd=0.31,
            usage={"input_tokens": 10, "output_tokens": 5},
        )

    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)
    with pytest.raises(LLMError) as ei:
        await ClaudeLLM().structured(
            task="qa:x", system="s", user="u", schema=QaOut, model="claude-haiku-4-5", max_budget_usd=0.3
        )
    assert ei.value.cost_usd == pytest.approx(0.31)


# ---- the catch-up check ------------------------------------------------------------------------
@respx.mock
def test_a_failed_catch_up_check_does_not_fail_the_finished_run(settings):
    settings.ntfy_topic = "tp"
    _mock_api()
    calls = {"n": 0}

    def config_cb(request):  # the run's own config read works; the catch-up check's does not
        calls["n"] += 1
        return httpx.Response(200, text=config_json()) if calls["n"] == 1 else httpx.Response(503)

    respx.get(f"{BASE}/api/worker/config").mock(side_effect=config_cb)
    alerts = respx.post("https://ntfy.sh/tp").mock(return_value=httpx.Response(200))
    api = WorkerApi(BASE, "tok", backoff=0)
    times = iter([NOW.astimezone(KHI), datetime(2026, 9, 23, 19, 40, tzinfo=KHI)])
    reports = run_editions(settings, api, _fake_llm(), FakeFetcher(), dry_run=False, clock=lambda: next(times))
    assert [(r.run_id, r.status) for r in reports] == [("2026-09-23-dopahar", "ok")]
    assert [c.request.headers["title"] for c in alerts.calls] == ["catch-up check failed"]


# ---- thread titles fit the API's 200 characters ------------------------------------------------
def test_thread_titles_are_clamped_to_the_api_limit():
    art = NumberedItem(idx=1, kind="article", db_id=1, title="T", text="x", source_name="Dawn")
    gw = GroupWork(group=Group(id=1, slug="g", name_en="G"), articles=[art], posts=[])
    out = CurateOut.model_validate(
        {
            "lead": "L",
            "stories": [{"ref": 1, "refs": [1], "thread_title": "Long " * 80, "title": "T", "summary": "S"}],
        }
    )
    gw.stories = curation_to_stories(out, gw, {}, "2026-09-23")
    assert len(gw.stories[0].thread_title_en) <= 200
    urdu = UrduOut.model_validate(
        {"stories": [{"idx": 1, "title_ur": "خبر", "summary_ur": "خلاصہ", "thread_title_ur": "طویل " * 80}]}
    )
    apply_urdu(urdu, gw)
    assert 0 < len(gw.stories[0].thread_title_ur) <= 200


# ---- a --groups run publishes only a complete edition ------------------------------------------
@respx.mock
def test_groups_run_on_a_draft_still_lacking_a_group_leaves_it_a_draft(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    respx.get(f"{ED}/2026-09-23/dopahar").mock(  # built by an earlier `--groups pakistan`: india is missing
        return_value=httpx.Response(200, json={"edition_id": 7, "status": "draft", "groups": ["pakistan"]})
    )
    api = WorkerApi(BASE, "tok", backoff=0)
    run = EditionRun(
        settings, api, _fake_llm(), FakeFetcher(), dry_run=False, groups=["pakistan"], now=NOW.astimezone(KHI)
    )
    report = run.run()
    assert put.called and json.loads(put.calls[0].request.content)["partial"] is True
    assert not pub.called and report.status == "ok" and report.publish_status == "draft"


@respx.mock
def test_resubmit_leaves_a_groups_draft_unpublished(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    put.mock(return_value=httpx.Response(503, json={"error": "down"}))
    api = WorkerApi(BASE, "tok", backoff=0)
    run = EditionRun(
        settings, api, _fake_llm(), FakeFetcher(), dry_run=False, groups=["pakistan"], now=NOW.astimezone(KHI)
    )
    with pytest.raises(ApiError):
        run.run()
    saved = settings.out_dir / "failed-2026-09-23-dopahar.json"
    assert json.loads(saved.read_text(encoding="utf-8"))["publish"] is False

    put.mock(return_value=httpx.Response(200, json={"edition_id": 7, "status": "draft", "stories": []}))
    pub.reset()
    result = resubmit(api, saved)
    assert result["put"] == "draft" and result["publish"] == "left-as-draft" and not pub.called


@respx.mock
def test_resubmit_still_publishes_a_full_run(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    pub.mock(return_value=httpx.Response(503, json={"error": "down"}))
    api = WorkerApi(BASE, "tok", backoff=0)
    with pytest.raises(ApiError):
        EditionRun(settings, api, _fake_llm(), FakeFetcher(), dry_run=False, now=NOW.astimezone(KHI)).run()
    saved = settings.out_dir / "failed-2026-09-23-dopahar.json"
    assert json.loads(saved.read_text(encoding="utf-8"))["publish"] is True
    respx.get(f"{ED}/2026-09-23/dopahar").mock(
        return_value=httpx.Response(200, json={"edition_id": 7, "status": "draft", "groups": ["pakistan"]})
    )
    pub.mock(return_value=httpx.Response(200, json={"status": "published", "url": "/en/2026-09-23/dopahar"}))
    assert resubmit(api, saved)["publish"] == "published"
