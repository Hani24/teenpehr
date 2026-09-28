"""What a run does before and around the editorial work: the edition check, the daily budget, alerts
for slots that get no edition, --groups runs, interrupts, spend accounting and catch-up."""

import json
from datetime import datetime

import httpx
import pytest
import respx

from conftest import config_json
from teenpehr.api import WorkerApi
from teenpehr.pipeline import EditionRun, run_editions
from test_pipeline import BASE, ED, KHI, NOW, FakeFetcher, _fake_llm, _mock_api

NTFY = "https://ntfy.sh/tp"


def _ntfy():
    return respx.post(NTFY).mock(return_value=httpx.Response(200))


def _titles(route) -> list[str]:
    return [c.request.headers["title"] for c in route.calls]


def _run(settings, llm=None, fetcher=None, **kw):
    api = WorkerApi(BASE, "tok", backoff=0)
    return EditionRun(settings, api, llm or _fake_llm(), fetcher or FakeFetcher(), now=NOW.astimezone(KHI), **kw)


def _spent(settings) -> float:
    f = settings.state_dir / "spend-2026-09-23.json"
    return json.loads(f.read_text())["usd"] if f.exists() else 0.0


# ---- the edition check (C3/C9) -----------------------------------------------------------------
@respx.mock
@pytest.mark.parametrize(("status", "why"), [("published", "already published"), ("review", "held for review")])
def test_published_or_held_edition_is_skipped_without_claude(settings, status, why):
    settings.ntfy_topic = "tp"
    runs, fin, items, put, pub, glos = _mock_api()
    respx.get(f"{ED}/2026-09-23/dopahar").mock(
        return_value=httpx.Response(200, json={"edition_id": 7, "status": status, "groups": ["pakistan"]})
    )
    alerts = _ntfy()
    llm = _fake_llm()
    report = _run(settings, llm=llm, dry_run=False).run()
    assert report.status == "skipped" and why in report.reason
    assert llm.calls == [] and not items.called and not put.called and not pub.called
    body = json.loads(fin.calls[0].request.content)
    assert body["status"] == "skipped" and body["model"] is None and body["error"] is None
    assert not alerts.called  # nothing is wrong: no FAILED alert


@respx.mock
def test_dry_run_of_a_published_edition_still_runs(settings):
    _mock_api()
    respx.get(f"{ED}/2026-09-23/dopahar").mock(
        return_value=httpx.Response(200, json={"edition_id": 7, "status": "published", "groups": []})
    )
    report = _run(settings, dry_run=True).run()
    assert report.status == "dry-run"


@respx.mock
def test_old_web_app_without_the_edition_route_does_not_block_runs(settings):
    _mock_api()
    respx.get(f"{ED}/2026-09-23/dopahar").mock(return_value=httpx.Response(405))
    assert _run(settings, dry_run=False).run().status == "ok"


# ---- budget and spend (#5, #6) -----------------------------------------------------------------
@respx.mock
def test_dry_runs_count_towards_the_daily_budget(settings):
    _mock_api()
    report = _run(settings, dry_run=True).run()
    assert report.status == "dry-run" and report.cost_usd > 0
    assert _spent(settings) == pytest.approx(report.cost_usd)


@respx.mock
def test_budget_skip_records_a_run_alerts_and_calls_no_claude(settings):
    settings.ntfy_topic = "tp"
    settings.daily_budget_usd = 1.0
    (settings.state_dir / "spend-2026-09-23.json").write_text(json.dumps({"usd": 1.2}))
    runs, fin, items, put, pub, glos = _mock_api()
    alerts = _ntfy()
    llm = _fake_llm()
    report = _run(settings, llm=llm, dry_run=False).run()
    assert report.status == "budget" and "daily budget reached" in report.reason
    assert llm.calls == [] and not items.called and not put.called
    body = json.loads(fin.calls[0].request.content)
    assert body["status"] == "skipped" and "daily budget reached" in body["error"]
    assert _titles(alerts) == ["2026-09-23-dopahar SKIPPED"]
    assert alerts.calls[0].request.headers["priority"] == "high"


@respx.mock
def test_empty_run_alerts(settings):
    settings.ntfy_topic = "tp"
    runs, fin, items, put, pub, glos = _mock_api()
    alerts = _ntfy()
    fetcher = FakeFetcher()
    fetcher.pages = {}
    report = _run(settings, fetcher=fetcher, dry_run=False).run()
    assert report.status == "empty" and not put.called
    body = json.loads(fin.calls[0].request.content)
    assert body["status"] == "empty" and body["model"] is None
    assert _titles(alerts) == ["2026-09-23-dopahar EMPTY"]


# ---- delivery races (C4) -----------------------------------------------------------------------
@respx.mock
def test_put_409_is_a_skip_not_a_failure(settings):
    settings.ntfy_topic = "tp"
    runs, fin, items, put, pub, glos = _mock_api()
    put.mock(return_value=httpx.Response(409, json={"error": "edition is published"}))
    alerts = _ntfy()
    report = _run(settings, dry_run=False).run()
    assert report.status == "skipped" and "edition is published" in report.reason
    assert not pub.called and not (settings.out_dir / "failed-2026-09-23-dopahar.json").exists()
    body = json.loads(fin.calls[-1].request.content)
    assert body["status"] == "skipped" and body["cost_usd"] > 0
    assert _titles(alerts) == ["2026-09-23-dopahar not delivered"]
    assert _spent(settings) > 0


@respx.mock
def test_review_after_publish_alerts_the_editor(settings):
    settings.ntfy_topic = "tp"
    runs, fin, items, put, pub, glos = _mock_api()
    pub.mock(return_value=httpx.Response(200, json={"status": "review", "flagged": 4}))
    alerts = _ntfy()
    report = _run(settings, dry_run=False).run()
    assert report.status == "ok" and report.publish_status == "review"
    assert _titles(alerts) == ["2026-09-23-dopahar held for review"]


# ---- --groups runs (#4) ------------------------------------------------------------------------
@respx.mock
def test_groups_run_on_an_existing_draft_is_partial_and_publishes(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    respx.get(f"{ED}/2026-09-23/dopahar").mock(
        return_value=httpx.Response(200, json={"edition_id": 7, "status": "draft", "groups": ["pakistan", "india"]})
    )
    report = _run(settings, dry_run=False, groups=["pakistan"]).run()
    body = json.loads(put.calls[0].request.content)
    assert body["partial"] is True and [g["group"] for g in body["groups"]] == ["pakistan"]
    assert pub.called and report.publish_status == "published"


@respx.mock
def test_groups_run_that_creates_the_edition_leaves_a_draft(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    report = _run(settings, dry_run=False, groups=["pakistan"]).run()
    assert put.called and json.loads(put.calls[0].request.content)["partial"] is True
    assert not pub.called and report.status == "ok" and report.publish_status == "draft"


@respx.mock
def test_unknown_group_is_refused_before_anything_runs(settings):
    runs, *_ = _mock_api()
    with pytest.raises(ValueError, match="unknown group"):
        _run(settings, dry_run=False, groups=["nowhere"]).run()
    assert not runs.called


# ---- interrupts (#50) --------------------------------------------------------------------------
@respx.mock
def test_interrupt_finishes_the_run_and_records_spend(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    llm = _fake_llm()

    def stop(_user):
        raise KeyboardInterrupt

    llm.responses["urdu:pakistan"] = stop
    with pytest.raises(KeyboardInterrupt):
        _run(settings, llm=llm, dry_run=False).run()
    body = json.loads(fin.calls[-1].request.content)
    assert body["status"] == "failed" and "interrupted" in body["error"]
    assert body["sources"]  # per-source results are kept on a failed run
    assert not put.called
    assert _spent(settings) == pytest.approx(0.01)  # the pakistan curation that ran before the stop


# ---- catch-up (C9) -----------------------------------------------------------------------------
def _clock(*times):
    it = iter(times)
    last = [times[-1]]

    def now():
        last[0] = next(it, last[0])
        return last[0]

    return now


@respx.mock
def test_a_slot_that_came_due_during_the_run_runs_next(settings):
    _mock_api()
    respx.get(f"{ED}/2026-09-23/shaam").mock(return_value=httpx.Response(404, json={"error": "not found"}))
    api = WorkerApi(BASE, "tok", backoff=0)
    clock = _clock(NOW.astimezone(KHI), datetime(2026, 9, 23, 19, 40, tzinfo=KHI))
    reports = run_editions(settings, api, _fake_llm(), FakeFetcher(), dry_run=False, clock=clock)
    assert [r.run_id for r in reports] == ["2026-09-23-dopahar", "2026-09-23-shaam"]
    assert reports[0].status == "ok"
    assert reports[1].status == "empty"  # the fixtures hold nothing inside the shaam window


@respx.mock
def test_no_catch_up_for_explicit_runs_or_after_a_budget_skip(settings):
    _mock_api()
    api = WorkerApi(BASE, "tok", backoff=0)
    late = datetime(2026, 9, 23, 19, 40, tzinfo=KHI)
    reports = run_editions(
        settings,
        api,
        _fake_llm(),
        FakeFetcher(),
        slot="dopahar",
        date="2026-09-23",
        clock=_clock(NOW.astimezone(KHI), late),
    )
    assert [r.run_id for r in reports] == ["2026-09-23-dopahar"]

    settings.daily_budget_usd = 0.0
    reports = run_editions(settings, api, _fake_llm(), FakeFetcher(), clock=_clock(NOW.astimezone(KHI), late))
    assert [r.status for r in reports] == ["budget"]


# ---- the timer (--scheduled): the admin's edition times decide, each slot runs once --------------
@respx.mock
def test_scheduled_runs_the_due_slot_once(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    api = WorkerApi(BASE, "tok", backoff=0)
    at = NOW.astimezone(KHI)  # 13:05: dopahar is due
    first = run_editions(settings, api, _fake_llm(), FakeFetcher(), scheduled=True, clock=_clock(at, at))
    assert [r.run_id for r in first] == ["2026-09-23-dopahar"] and first[0].status == "ok"
    llm = _fake_llm()
    again = run_editions(settings, api, llm, FakeFetcher(), scheduled=True, clock=_clock(at.replace(minute=15)))
    assert again == [] and llm.calls == [] and runs.call_count == 1  # no run row, no Claude


@respx.mock
def test_scheduled_follows_edition_times_changed_in_the_admin(settings):
    cfg = json.loads(config_json())
    cfg["settings"]["edition_times"]["dopahar"] = "13:30"
    _mock_api()
    respx.get(f"{BASE}/api/worker/config").mock(return_value=httpx.Response(200, json=cfg))
    respx.get(f"{ED}/2026-09-23/subh").mock(
        return_value=httpx.Response(200, json={"edition_id": 6, "status": "published", "groups": ["pakistan"]})
    )
    api = WorkerApi(BASE, "tok", backoff=0)
    at = NOW.astimezone(KHI)  # 13:05: with dopahar moved to 13:30, subh is still the latest due slot
    reports = run_editions(settings, api, _fake_llm(), FakeFetcher(), scheduled=True, clock=_clock(at, at))
    assert [(r.run_id, r.status) for r in reports] == [("2026-09-23-subh", "skipped")]
    later = at.replace(minute=30)
    reports = run_editions(settings, api, _fake_llm(), FakeFetcher(), scheduled=True, clock=_clock(later, later))
    assert [(r.run_id, r.status) for r in reports] == [("2026-09-23-dopahar", "ok")]


@respx.mock
def test_scheduled_with_the_web_app_down_alerts_once_per_slot_then_runs_when_it_is_back(settings):
    _mock_api()
    api = WorkerApi(BASE, "tok", backoff=0)
    at = NOW.astimezone(KHI)
    cfg = respx.get(f"{BASE}/api/worker/config")
    cfg.side_effect = httpx.ConnectError("refused")
    with pytest.raises(httpx.ConnectError):  # the unit fails: systemd's OnFailure alerts
        run_editions(settings, api, _fake_llm(), FakeFetcher(), scheduled=True, clock=_clock(at))
    assert run_editions(settings, api, _fake_llm(), FakeFetcher(), scheduled=True, clock=_clock(at)) == []  # quiet
    cfg.side_effect = None
    cfg.mock(return_value=httpx.Response(200, text=config_json()))
    later = at.replace(minute=25)
    reports = run_editions(settings, api, _fake_llm(), FakeFetcher(), scheduled=True, clock=_clock(later, later))
    assert [(r.run_id, r.status) for r in reports] == [("2026-09-23-dopahar", "ok")]


@respx.mock
def test_scheduled_catch_up_marks_the_extra_slot_as_run(settings):
    _mock_api()
    respx.get(f"{ED}/2026-09-23/shaam").mock(return_value=httpx.Response(404, json={"error": "not found"}))
    api = WorkerApi(BASE, "tok", backoff=0)
    late = datetime(2026, 9, 23, 19, 40, tzinfo=KHI)
    clock = _clock(NOW.astimezone(KHI), late)
    reports = run_editions(settings, api, _fake_llm(), FakeFetcher(), scheduled=True, clock=clock)
    assert [r.run_id for r in reports] == ["2026-09-23-dopahar", "2026-09-23-shaam"]
    assert run_editions(settings, api, _fake_llm(), FakeFetcher(), scheduled=True, clock=_clock(late)) == []


# ---- stories are written from what the citation shows (#40) --------------------------------------
@respx.mock
def test_an_existing_item_is_shown_to_claude_as_first_stored(settings):
    runs, fin, items, put, pub, glos = _mock_api()

    def items_cb(request):
        body = json.loads(request.content)
        out = []
        for n, it in enumerate(body["items"], 1):
            row = {"url_canonical": it["url_canonical"], "id": 9000 + n, "is_new": n != 1}
            if n == 1:
                row["stored"] = {"title": "Headline as first stored", "text": "Stored text.", "published_at": None}
            out.append(row)
        return httpx.Response(200, json={"items": out})

    items.mock(side_effect=items_cb)
    llm = _fake_llm()
    _run(settings, llm=llm).run()
    first_sent = json.loads(items.calls[0].request.content)["items"][0]["title"]
    prompts = "\n".join(c["user"] for c in llm.calls if c["task"].startswith("curate:"))
    assert "Headline as first stored" in prompts and first_sent not in prompts


class _SignedOut:
    """An LLM whose Claude Code CLI is not signed in; counts how often it was asked."""

    def __init__(self):
        self.asked = 0

    def auth_problem(self):
        from teenpehr.llm import NOT_SIGNED_IN

        self.asked += 1
        return NOT_SIGNED_IN

    async def structured(self, **kw):  # pragma: no cover - never reached signed out
        raise AssertionError("no Claude call signed out")


@respx.mock
def test_scheduled_with_the_cli_signed_out_alerts_once_per_due_slot_and_runs_once_signed_in(settings):
    from teenpehr.pipeline import ConfigError

    runs, *_ = _mock_api()
    api = WorkerApi(BASE, "tok", backoff=0)
    at = NOW.astimezone(KHI)
    out = _SignedOut()
    with pytest.raises(ConfigError, match="not signed in"):  # the unit fails once: OnFailure alerts
        run_editions(settings, api, out, FakeFetcher(), scheduled=True, clock=_clock(at))
    assert run_editions(settings, api, out, FakeFetcher(), scheduled=True, clock=_clock(at)) == []  # quiet
    assert not runs.called
    later = at.replace(minute=25)
    reports = run_editions(settings, api, _fake_llm(), FakeFetcher(), scheduled=True, clock=_clock(later, later))
    assert [(r.run_id, r.status) for r in reports] == [("2026-09-23-dopahar", "ok")]
    # nothing due: the CLI is never asked, nothing raised
    asked = out.asked
    assert run_editions(settings, api, out, FakeFetcher(), scheduled=True, clock=_clock(later)) == []
    assert out.asked == asked
