"""`teenpehr jobs` (docs/API.md § Jobs): claim, context, handler, report, usage. The web API is mocked with
respx; the article fetch and Claude are fakes, so nothing touches the network."""

from __future__ import annotations

import asyncio
import io
import json
from datetime import UTC, datetime

import httpx
import pytest
import respx
from PIL import Image

from teenpehr.api import WorkerApi
from teenpehr.fetch.http import FetchResult
from teenpehr.jobs import JobRunner, budget
from teenpehr.jobs.fulltext import FullText, TryLater, Unavailable
from teenpehr.llm import LLMError
from test_jobs_translate import FakeClaude

BASE = "http://web.test"
NOW = "2026-09-29T04:00:00+00:00"


def job_json(id_: int, kind: str, payload: dict, attempts: int = 1, max_attempts: int = 3) -> dict:
    return {
        "id": id_,
        "kind": kind,
        "payload": payload,
        "priority": 0,
        "attempts": attempts,
        "max_attempts": max_attempts,
        "locked_by": "w",
        "locked_until": NOW,
        "requested_by": 5,
        "created_at": NOW,
    }


SOURCE = {
    "id": 11,
    "name": "Dawn",
    "kind": "rss",
    "route": "direct",
    "lang": "en",
    "url": "https://dawn.test/feed",
    "perspective": "",
    "fetcher_tier": 0,
}
ITEM = {
    "id": 9001,
    "url": "https://dawn.test/news/1",
    "url_canonical": "dawn.test/news/1",
    "title": "Govt cuts petrol price",
    "lang": "en",
    "published_at": NOW,
    "description": None,
    "image_url": None,
    "site_name": None,
    "author": None,
    "source": SOURCE,
}
GLOSSARY = [{"term_en": "Shehbaz Sharif", "term_ur": "شہباز شریف", "kind": "person"}]
PARAS = [
    "The government on Monday cut the petrol price by Rs2.27 per litre.",
    "Petrol will now retail at Rs389.03 per litre, officials said.",
    "Prime Minister Shehbaz Sharif welcomed the decision.",
]
STORY = {
    "id": 3001,
    "origin": "manual",
    "placement": "desk",
    "tag": "worth-knowing",
    "title_en": "Flood hits 12 villages",
    "title_ur": "",
    "summary_en": "Floods hit 12 villages near Sukkur, officials said.",
    "summary_ur": "",
    "why_en": "",
    "why_ur": "",
    "contested_en": "",
    "contested_ur": "",
    "language_filled": None,
    "created_by_name": "Hani",
    "image_id": None,
    "desk_at": None,
    "edition_status": "draft",
    "group": {"slug": "pakistan", "name_en": "Pakistan", "name_ur": "پاکستان"},
}
MANUAL_ITEM = {
    **ITEM,
    "id": 9100,
    "url": "https://site.test/story",
    "source": {**SOURCE, "id": 99, "name": "site.test", "kind": "manual"},
    "site_name": "Site News",
}


class FakeFullText:
    def __init__(self, result=None):
        self.result = result
        self.calls: list[tuple[str, str, bool]] = []

    def fetch(self, url, *, route="direct", last_attempt=False, title_hint=""):
        self.calls.append((url, route, last_attempt))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result or FullText(
            url=url, final_url=url, route=route, title=title_hint, paragraphs=list(PARAS), lang="en"
        )


class Api:
    """The job routes, recording what the runner sends."""

    def __init__(self, jobs: list[dict | None], contexts: dict[int, dict], done_status: int = 200):
        self.jobs = list(jobs)
        self.contexts = contexts
        self.claims: list[dict] = []
        self.done: list[tuple[int, dict]] = []
        self.failed: list[tuple[int, dict]] = []
        self.done_status = done_status
        respx.post(f"{BASE}/api/worker/jobs/claim").mock(side_effect=self._claim)
        respx.get(url__regex=rf"{BASE}/api/worker/jobs/\d+/context").mock(side_effect=self._context)
        respx.post(url__regex=rf"{BASE}/api/worker/jobs/\d+/done").mock(side_effect=self._done)
        respx.post(url__regex=rf"{BASE}/api/worker/jobs/\d+/fail").mock(side_effect=self._fail)

    @staticmethod
    def _id(request) -> int:
        return int(request.url.path.split("/")[4])

    def _claim(self, request):
        self.claims.append(json.loads(request.content))
        return httpx.Response(200, json={"job": self.jobs.pop(0) if self.jobs else None})

    def _context(self, request):
        ctx = self.contexts.get(self._id(request))
        return httpx.Response(200, json=ctx) if ctx else httpx.Response(404, json={"error": "job not found"})

    def _done(self, request):
        body = json.loads(request.content)
        self.done.append((self._id(request), body))
        if self.done_status != 200:
            return httpx.Response(self.done_status, json={"error": "refused", "issues": [{"path": "result.title"}]})
        status = "blocked" if "blocked" in body["result"] else "done"
        return httpx.Response(200, json={"ok": True, "status": status, "applied": True})

    def _fail(self, request):
        body = json.loads(request.content)
        self.failed.append((self._id(request), body))
        status = "queued" if body.get("retry") else ("blocked" if body.get("blocked") else "failed")
        return httpx.Response(
            200, json={"ok": True, "status": status, **({"retry_at": NOW} if status == "queued" else {})}
        )


def runner(settings, *, llm=None, fulltext=None, edition=False, fetcher=None, kinds=None):
    api = WorkerApi(BASE, "tok", backoff=0)
    return JobRunner(
        settings,
        api,
        llm or FakeClaude(),
        fetcher or object(),
        fulltext=fulltext or FakeFullText(),
        edition_running=lambda: edition,
        worker_id="test-worker",
        kinds=kinds,
    )


def translate_ctx(id_=1, **item) -> dict:
    return {
        "job": {"id": id_},
        "item": {**ITEM, **item},
        "translation": {"status": "running", "source_text_hash": None, "finished_at": None},
        "glossary": GLOSSARY,
    }


@respx.mock
async def test_a_translation_job_is_fetched_translated_checked_and_reported(settings):
    api = Api([job_json(1, "translate_article", {"item_id": 9001, "lang": "ur"})], {1: translate_ctx()})
    ft = FakeFullText()
    llm = FakeClaude()
    r = runner(settings, llm=llm, fulltext=ft)
    report = await r.run(once=True)
    assert api.claims[0] == {
        "kinds": ["translate_article", "fill_language", "story_image"],
        "worker_id": "test-worker",
        "lease_s": 1800,
    }
    assert ft.calls == [("https://dawn.test/news/1", "direct", False)]
    ((jid, body),) = api.done
    res = body["result"]
    assert jid == 1 and body["worker_id"] == "test-worker"
    assert res["body"].count("\n\n") == 2 and res["title"] and res["source_words"] > 20
    assert len(res["source_text_hash"]) == 64 and res["check_ok"] is True and res["model"] == settings.news_model_urdu
    assert res["cost_usd"] == pytest.approx(0.04) and res["tokens_in"] == 2000
    # The context's glossary (locked entries, served without the flag) is mandatory in the prompt.
    system = next(c["system"] for c in llm.calls if c["kind"] == "translate")
    assert "Shehbaz Sharif → شہباز شریف" in system.split("Suggested")[0]
    assert report.jobs[0].status == "done" and report.status == "ok"
    assert budget.spent_today(settings) == pytest.approx(0.04)  # counted toward the daily ceiling


@respx.mock
async def test_an_article_that_cannot_be_had_is_a_blocked_result_without_claude(settings):
    api = Api([job_json(2, "translate_article", {"item_id": 9001, "lang": "ur"})], {2: translate_ctx(2)})
    llm = FakeClaude()
    r = runner(settings, llm=llm, fulltext=FakeFullText(Unavailable("paywalled", "the publisher marks it as not free")))
    await r.run(once=True)
    ((_, body),) = api.done
    assert body["result"]["blocked"] == {"reason": "paywalled", "note": "the publisher marks it as not free"}
    assert llm.calls == []


@pytest.mark.parametrize(
    ("item", "reason"),
    [
        ({"lang": "ur"}, "not_article"),
        ({"url": "https://www.youtube.com/watch?v=x"}, "not_article"),
        ({"url": "https://news.google.com/rss/articles/abc"}, "unreachable"),
    ],
)
@respx.mock
async def test_items_refused_without_any_fetch(settings, item, reason):
    api = Api([job_json(3, "translate_article", {"item_id": 9001, "lang": "ur"})], {3: translate_ctx(3, **item)})
    ft = FakeFullText()
    await runner(settings, fulltext=ft).run(once=True)
    assert api.done[0][1]["result"]["blocked"]["reason"] == reason and ft.calls == []


@respx.mock
async def test_temporary_fetch_trouble_is_a_retryable_failure_and_the_last_attempt_is_marked(settings):
    api = Api([job_json(4, "translate_article", {"item_id": 9001, "lang": "ur"}, attempts=3)], {4: translate_ctx(4)})
    ft = FakeFullText(TryLater("dawn.test answered HTTP 503", 600))
    await runner(settings, fulltext=ft).run(once=True)
    assert ft.calls[0][2] is True  # last attempt: the fetcher turns trouble into a final answer
    ((_, body),) = api.failed
    assert body["retry"] is True and body["retry_after_s"] == 600 and "503" in body["error"]


@respx.mock
async def test_a_publishers_huge_retry_after_is_kept_within_a_day(settings):
    api = Api([job_json(12, "translate_article", {"item_id": 9001, "lang": "ur"})], {12: translate_ctx(12)})
    await runner(settings, fulltext=FakeFullText(TryLater("dawn.test asked us to slow down (429)", 10**7))).run(
        once=True
    )
    ((_, body),) = api.failed
    assert body["retry"] is True and body["retry_after_s"] == 86_400


@respx.mock
async def test_an_unchanged_article_with_a_done_translation_is_not_redone(settings):
    from teenpehr.jobs.fulltext import FullText as FT

    full = FT(url="u", final_url="u", route="direct", title="t", paragraphs=list(PARAS), lang="en")
    ctx = translate_ctx(5)
    ctx["translation"] = {"status": "done", "source_text_hash": full.text_hash, "finished_at": NOW}
    api = Api([job_json(5, "translate_article", {"item_id": 9001, "lang": "ur"})], {5: ctx})
    llm = FakeClaude()
    await runner(settings, llm=llm, fulltext=FakeFullText(full)).run(once=True)
    assert llm.calls == [] and api.failed[0][1]["retry"] is False and "not changed" in api.failed[0][1]["error"]


@respx.mock
async def test_a_claude_failure_is_retried_later_and_its_cost_counted(settings):
    api = Api([job_json(6, "translate_article", {"item_id": 9001, "lang": "ur"})], {6: translate_ctx(6)})
    llm = FakeClaude({"translate": LLMError("translate: error_max_budget_usd", cost_usd=0.3)})
    await runner(settings, llm=llm).run(once=True)
    ((_, body),) = api.failed
    assert body["retry"] is True and "Claude call failed" in body["error"]
    assert budget.spent_today(settings) == pytest.approx(0.3)


@respx.mock
async def test_nothing_queued_is_idle(settings):
    api = Api([None], {})
    report = await runner(settings).run(once=True)
    assert report.status == "idle" and report.jobs == [] and len(api.claims) == 1


@respx.mock
async def test_over_the_daily_ceiling_only_jobs_without_claude_are_claimed(settings):
    budget.add_spend(settings, settings.daily_budget_usd)
    api = Api([None], {})
    await runner(settings).run(once=True)
    assert api.claims[0]["kinds"] == ["story_image"]


@respx.mock
async def test_signed_out_claude_or_an_edition_run_hold_back_the_kinds_they_affect(settings):
    class SignedOut(FakeClaude):
        def auth_status(self):
            return {"logged_in": False}

    api = Api([None, None], {})
    await runner(settings, llm=SignedOut()).run(once=True)
    assert api.claims[0]["kinds"] == ["story_image"]
    await runner(settings, edition=True).run(once=True)
    assert api.claims[1]["kinds"] == ["fill_language"]


@respx.mock
async def test_with_nothing_claimable_once_says_why(settings):
    budget.add_spend(settings, settings.daily_budget_usd)
    api = Api([], {})
    report = await runner(settings, kinds=["translate_article"]).run(once=True)
    assert report.status == "not_claimable" and "daily usage ceiling" in report.reason and api.claims == []


@respx.mock
async def test_a_vanished_job_or_item_fails_for_good(settings):
    api = Api([job_json(7, "translate_article", {"item_id": 9001, "lang": "ur"})], {})
    await runner(settings).run(once=True)
    assert api.failed[0][1]["retry"] is False and "404" in api.failed[0][1]["error"]


@respx.mock
async def test_a_result_the_site_refuses_is_reported_as_a_final_failure(settings):
    api = Api(
        [job_json(8, "translate_article", {"item_id": 9001, "lang": "ur"})], {8: translate_ctx(8)}, done_status=400
    )
    report = await runner(settings).run(once=True)
    assert api.failed[0][1]["retry"] is False and "result refused" in api.failed[0][1]["error"]
    assert report.jobs[0].status == "failed"


@respx.mock
async def test_a_result_the_web_app_could_not_take_waits_in_the_outbox(settings):
    api = Api(
        [job_json(9, "translate_article", {"item_id": 9001, "lang": "ur"})], {9: translate_ctx(9)}, done_status=503
    )
    r = runner(settings)
    r.api.retries = 1
    report = await r.run(once=True)
    assert report.jobs[0].status == "outbox"
    kept = settings.state_dir / "job-outbox" / "9.json"
    assert kept.exists() and json.loads(kept.read_text())["op"] == "done"
    api.done_status = 200
    api.jobs = [None]
    await runner(settings).run(once=True)  # the next start sends it before claiming
    assert len(api.done) == 2 and api.done[-1][1]["worker_id"] == "test-worker" and not kept.exists()


@respx.mock
async def test_fill_language_writes_the_missing_side(settings):
    ctx = {"job": {"id": 20}, "story": STORY, "sources": [{**MANUAL_ITEM, "is_primary": True}], "glossary": GLOSSARY}
    api = Api([job_json(20, "fill_language", {"story_id": 3001, "lang": "ur"})], {20: ctx})
    llm = FakeClaude(
        {
            "fill": {
                "title": "سیلاب سے 12 گاؤں متاثر",
                "summary": "حکام کے مطابق سکھر کے قریب 12 گاؤں سیلاب سے متاثر ہوئے۔",
            }
        }
    )
    await runner(settings, llm=llm).run(once=True)
    assert "Shehbaz Sharif → شہباز شریف" in llm.calls[0]["system"].split("Suggested")[0]
    ((_, body),) = api.done
    assert body["result"]["fields"]["ur"]["title"] == "سیلاب سے 12 گاؤں متاثر"
    assert body["result"]["fields"]["ur"]["why"] == "" and body["result"]["model"] == settings.news_model_urdu


@pytest.mark.parametrize(
    ("story", "error"),
    [
        ({"desk_at": NOW}, "live"),
        ({"edition_status": "published"}, "live"),
        ({"origin": "ai"}, "not a manual story"),
        ({"title_en": "", "summary_en": ""}, "nothing to write from"),
    ],
)
@respx.mock
async def test_fill_language_refusals_spend_nothing(settings, story, error):
    ctx = {"job": {"id": 21}, "story": {**STORY, **story}, "sources": [], "glossary": []}
    api = Api([job_json(21, "fill_language", {"story_id": 3001, "lang": "ur"})], {21: ctx})
    llm = FakeClaude()
    await runner(settings, llm=llm).run(once=True)
    assert llm.calls == [] and api.failed[0][1]["retry"] is False and error in api.failed[0][1]["error"]


@respx.mock
async def test_fill_with_every_field_already_written_costs_nothing(settings):
    story = {**STORY, "title_ur": "سیلاب", "summary_ur": "سکھر میں سیلاب۔"}
    ctx = {"job": {"id": 22}, "story": story, "sources": [], "glossary": []}
    api = Api([job_json(22, "fill_language", {"story_id": 3001, "lang": "ur"})], {22: ctx})
    llm = FakeClaude()
    await runner(settings, llm=llm).run(once=True)
    assert llm.calls == [] and api.done[0][1]["result"]["fields"]["ur"]["title"] == "سیلاب"


# ---- story_image --------------------------------------------------------------------------------
def jpeg(w=1200, h=800) -> bytes:
    buf = io.BytesIO()
    Image.linear_gradient("L").resize((w, h)).convert("RGB").save(buf, "JPEG", quality=85)
    return buf.getvalue()


class SiteFetcher:
    def __init__(self):
        self.calls: list[str] = []

    def cooldown_left(self, url):
        return 0.0

    def save_state(self):
        pass

    def get(self, url, *, route="direct", headers=None, allow_fallback=True, max_bytes=0, hard_limit=False, **kw):
        self.calls.append(url)
        if url.endswith("/robots.txt"):
            return FetchResult(url=url, status=404, error="http 404")
        if url == "https://site.test/story":
            page = b'<html><head><meta property="og:image" content="https://img.site.test/lead.jpg"><meta property="og:image:alt" content="Flooded village"></head></html>'
            return FetchResult(url=url, status=200, content=page, headers={"content-type": "text/html"}, final_url=url)
        if url == "https://img.site.test/lead.jpg":
            return FetchResult(
                url=url, status=200, content=jpeg(), headers={"content-type": "image/jpeg"}, final_url=url
            )
        return FetchResult(url=url, status=404, error="http 404")


def image_ctx(id_: int, **story) -> dict:
    return {
        "job": {"id": id_},
        "story": {**STORY, **story},
        "item": MANUAL_ITEM,
        "sources": [{**MANUAL_ITEM, "is_primary": True}],
    }


@respx.mock
async def test_story_image_uses_the_linked_pages_image_checked_and_uploaded(settings):
    settings.images = True
    api = Api([job_json(30, "story_image", {"story_id": 3001, "item_id": 9100})], {30: image_ctx(30)})
    uploads: list[dict] = []
    respx.post(f"{BASE}/api/worker/images").mock(
        side_effect=lambda req: (
            uploads.append(json.loads(req.content)),
            httpx.Response(201, json={"image_id": 71, "created": True}),
        )[1]
    )
    llm = FakeClaude({"image": {"graphic": False, "placeholder_or_logo": False}})
    fetcher = SiteFetcher()
    await runner(settings, llm=llm, fetcher=fetcher).run(once=True)
    ((_, body),) = api.done
    assert body["result"]["image_id"] == 71 and "checked image" in body["result"]["note"]
    up = uploads[0]
    assert up["item_id"] == 9100 and up["source_id"] == 99 and up["credit"] == "Site News"
    assert up["alt"] == "Flooded village" and up["graphic"] is False and [v["w"] for v in up["variants"]] == [480, 960]
    assert "https://site.test/robots.txt" in fetcher.calls  # robots.txt before the page


@respx.mock
async def test_story_image_with_no_usable_image_or_images_off_is_a_normal_null(settings):
    api = Api([job_json(31, "story_image", {"story_id": 3001, "item_id": 9100})], {31: image_ctx(31)})
    await runner(settings, fetcher=SiteFetcher()).run(once=True)  # conftest turns images off
    assert api.done[0][1]["result"] == {"image_id": None, "note": "images are turned off on the worker (IMAGES=0)"}
    settings.images = True
    api.jobs = [job_json(32, "story_image", {"story_id": 3001, "item_id": 9100})]
    api.contexts[32] = image_ctx(32, image_id=5)
    await runner(settings, fetcher=SiteFetcher()).run(once=True)
    assert api.done[1][1]["result"]["image_id"] is None and "already has an image" in api.done[1][1]["result"]["note"]


# ---- stopping ------------------------------------------------------------------------------------
@respx.mock
async def test_an_interrupted_job_is_queued_again(settings):
    api = Api([job_json(40, "translate_article", {"item_id": 9001, "lang": "ur"})], {40: translate_ctx(40)})

    class Slow(FakeClaude):
        async def structured(self, **kw):
            await asyncio.sleep(30)
            raise AssertionError("not reached")

    r = runner(settings, llm=Slow())
    task = asyncio.create_task(r.run())
    for _ in range(200):
        await asyncio.sleep(0.02)
        if r._tasks:
            break
    r.stop()  # first signal: let it finish...
    await asyncio.sleep(0.05)
    assert not task.done()
    r.interrupt("test")  # ...second: stop now
    report = await asyncio.wait_for(task, 5)
    assert report.status == "interrupted"
    ((_, body),) = api.failed
    assert body["retry"] is True and body["retry_after_s"] == 60 and "interrupted" in body["error"]


@respx.mock
async def test_stop_while_idle_ends_the_loop_at_once(settings):
    Api([None] * 100, {})
    settings.jobs_poll_s = 30
    r = runner(settings)
    task = asyncio.create_task(r.run())
    await asyncio.sleep(0.1)
    r.stop()
    report = await asyncio.wait_for(task, 2)
    assert report.status == "stopped"


@respx.mock
async def test_the_web_app_down_backs_off_and_once_reports_it(settings):
    respx.post(f"{BASE}/api/worker/jobs/claim").mock(side_effect=httpx.ConnectError("refused"))
    r = runner(settings)
    r.api.retries = 1
    report = await r.run(once=True)
    assert report.status == "api_error" and "ConnectError" in report.reason


def test_spend_is_shared_with_the_edition_runs_file_format(settings):
    f = budget.spend_file(settings, datetime(2026, 9, 29, 20, 0, tzinfo=UTC))  # 01:00 on the 30th in Karachi
    assert f.name == "spend-2026-09-30.json"
    budget.add_spend(settings, 0.5)
    budget.add_spend(settings, 0.25)
    assert json.loads(budget.spend_file(settings).read_text()) == {"usd": 0.75}
    assert budget.budget_left(settings) == pytest.approx(settings.daily_budget_usd - 0.75)
    assert 60 <= budget.seconds_to_midnight(settings) <= 86_400


# ---- review fixes --------------------------------------------------------------------------------
def test_the_edition_run_counts_as_running_while_its_oneshot_unit_is_activating(monkeypatch):
    """news-worker.service is Type=oneshot: during the run systemd reports it `activating`, which
    `systemctl is-active` does not call active, so the runner reads ActiveState."""
    import subprocess

    from teenpehr.jobs import runner as runner_mod

    seen: list[list[str]] = []
    state = {"v": "activating"}

    def fake_run(cmd, **kw):
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout=state["v"] + "\n", stderr="")

    monkeypatch.setattr(runner_mod.shutil, "which", lambda name: "/usr/bin/systemctl")
    monkeypatch.setattr(runner_mod.subprocess, "run", fake_run)
    assert runner_mod.unit_active() is True
    assert "ActiveState" in " ".join(seen[0]) and "news-worker.service" in seen[0]
    for s, want in (("active", True), ("deactivating", True), ("inactive", False), ("failed", False), ("", False)):
        state["v"] = s
        assert runner_mod.unit_active() is want


@respx.mock
async def test_a_job_still_running_near_the_end_of_its_lease_is_stopped_and_queued_again(settings):
    api = Api([job_json(50, "translate_article", {"item_id": 9001, "lang": "ur"})], {50: translate_ctx(50)})

    class Slow(FakeClaude):
        async def structured(self, **kw):
            await asyncio.sleep(30)
            raise AssertionError("not reached")

    r = runner(settings, llm=Slow())
    assert r.lease_s == 1800 and r.job_time_limit_s == 1800 - 90
    r.job_time_limit_s = 0.1
    report = await asyncio.wait_for(r.run(once=True), 5)
    ((_, body),) = api.failed
    assert body["retry"] is True and "lease" in body["error"] and report.jobs[0].status == "queued"


@respx.mock
async def test_an_article_over_its_own_usage_limit_is_blocked_too_long_not_retried(settings):
    settings.translate_max_usd = 0.01
    settings.translate_chunk_words = 100
    long_paras = [f"{'word ' * 90}paragraph {i}." for i in range(3)]
    full = FullText(url="u", final_url="u", route="direct", title="t", paragraphs=long_paras, lang="en")
    api = Api([job_json(51, "translate_article", {"item_id": 9001, "lang": "ur"})], {51: translate_ctx(51)})
    llm = FakeClaude()
    await runner(settings, llm=llm, fulltext=FakeFullText(full)).run(once=True)
    assert api.failed == []
    ((_, body),) = api.done
    res = body["result"]
    assert res["blocked"]["reason"] == "too_long" and "usage limit" in res["blocked"]["note"]
    assert res["cost_usd"] == pytest.approx(0.02) and len(llm.calls) == 1  # the first chunk, then no more
    assert budget.spent_today(settings) == pytest.approx(0.02)


@respx.mock
async def test_parallel_loops_never_claim_more_than_max_jobs(settings):
    jobs = [job_json(60 + i, "story_image", {"story_id": 3001, "item_id": 9100}) for i in range(5)]
    api = Api(jobs, {60 + i: image_ctx(60 + i) for i in range(5)})
    r = runner(settings, fetcher=SiteFetcher())
    r.concurrency = 3
    report = await asyncio.wait_for(r.run(max_jobs=2), 5)
    assert len(api.claims) == 2 and len(report.jobs) == 2
