import copy
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import respx

from conftest import CONFIG, config_json, fixture_text
from teenpehr.api import WorkerApi
from teenpehr.collect_x import run_collect_x
from teenpehr.social.x_list import XListClient, XListError, XRateLimited

BASE = "http://web.test"
NTFY = "https://ntfy.sh/tp-test"
TWITTERAPI = "https://api.twitterapi.io/twitter/user/last_tweets"
# the fixture list's newest post is 2026-09-23 14:17 UTC; an hour later the list is healthy
NOW = datetime(2026, 9, 23, 15, 15, tzinfo=UTC)


def _client(calls, fail: dict | None = None):
    fail = fail or {}

    def fetch(url, headers):
        calls.append(url)
        assert headers["Accept"].startswith("text/html")
        list_id = url.rsplit("/", 1)[-1]
        if list_id in fail:
            raise fail[list_id]
        return fixture_text("x_list_84839422.html")

    return XListClient(fetch, spacing_s=0)


def _posts_cb(request):
    body = json.loads(request.content)
    return httpx.Response(
        200,
        json={
            "posts": [
                {
                    "platform_id": p["platform_id"],
                    "id": 100 + n,
                    "is_new": n % 2 == 0,
                    "handle_id": {"Movies": 6, "HamidMirPAK": 5}.get(p["author_handle"]),
                }
                for n, p in enumerate(body["posts"])
            ]
        },
    )


def _config(list_ids=("84839422",), hamid_last_post=None) -> str:
    cfg = copy.deepcopy(CONFIG)
    cfg["groups"][0]["x_list_ids"] = list(list_ids[:1])
    cfg["groups"][1]["x_list_ids"] = list(list_ids[1:])
    if hamid_last_post:
        cfg["handles"][0]["last_post_at"] = hamid_last_post.isoformat()
    return json.dumps(cfg)


def _mock_web(config: str | None = None):
    respx.get(f"{BASE}/api/worker/config").mock(return_value=httpx.Response(200, text=config or config_json()))
    runs = respx.post(f"{BASE}/api/worker/runs").mock(return_value=httpx.Response(201, json={"id": 77}))
    fin = respx.patch(f"{BASE}/api/worker/runs/77").mock(return_value=httpx.Response(200, json={}))
    posts = respx.post(f"{BASE}/api/worker/posts").mock(side_effect=_posts_cb)
    seen = respx.post(url__regex=rf"{BASE}/api/worker/handles/\d+/seen").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    return runs, fin, posts, seen


def _api():
    return WorkerApi(BASE, "tok", backoff=0)


@respx.mock
def test_collect_x_posts_and_marks_handles(settings):
    runs, fin, posts, seen = _mock_web()
    calls = []
    report = run_collect_x(settings, _api(), _client(calls), dry_run=False, now=NOW)
    assert calls == ["https://syndication.twitter.com/srv/timeline-list/list-id/84839422"]
    assert report.lists == 1 and report.posts == 97 and report.new_posts > 0 and report.status == "ok"
    assert runs.called and posts.called and seen.called
    assert json.loads(fin.calls[0].request.content)["status"] == "ok"


@respx.mock
def test_collect_x_dry_run_makes_no_writes(settings):
    runs, _, posts, _ = _mock_web()
    settings.ntfy_topic = "tp-test"
    ntfy = respx.post(NTFY).mock(return_value=httpx.Response(200))
    report = run_collect_x(settings, _api(), _client([], fail={"84839422": XListError("gone")}), dry_run=True)
    assert report.status == "failed" and not runs.called and not posts.called and not ntfy.called


@respx.mock
def test_every_list_failing_fails_the_run_and_alerts_once_until_it_recovers(settings):
    _, fin, _, _ = _mock_web(_config(["84839422", "555"]))
    settings.ntfy_topic = "tp-test"
    ntfy = respx.post(NTFY).mock(return_value=httpx.Response(200))
    dead = {"84839422": XListError("no __NEXT_DATA__ in response"), "555": RuntimeError("http 503")}

    t0 = NOW - timedelta(hours=7)  # so the fixture list is fresh again when it comes back at NOW
    report = run_collect_x(settings, _api(), _client([], fail=dead), dry_run=False, now=t0)
    assert report.status == "failed" and report.lists == 2 and report.lists_ok == 0
    finish = json.loads(fin.calls[-1].request.content)
    assert finish["status"] == "failed" and "all 2 X lists failed" in finish["error"]
    assert ntfy.call_count == 1
    req = ntfy.calls[-1].request
    assert req.headers["Title"] == "X collector: every list failed" and req.headers["Priority"] == "high"
    assert "84839422" in req.content.decode() and "555" in req.content.decode()

    # thirty minutes later, still dead: no second alert yet
    run_collect_x(settings, _api(), _client([], fail=dead), dry_run=False, now=t0 + timedelta(minutes=30))
    assert ntfy.call_count == 1
    # six hours on: a reminder
    run_collect_x(settings, _api(), _client([], fail=dead), dry_run=False, now=t0 + timedelta(hours=6, minutes=5))
    assert ntfy.call_count == 2

    # back: one all-clear, then silence
    report = run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW)
    assert report.status == "ok" and ntfy.call_count == 3
    assert ntfy.calls[-1].request.headers["Title"] == "X collector: back to normal"
    assert "list 555 (india): fine again" in ntfy.calls[-1].request.content.decode()
    run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW + timedelta(minutes=30))
    assert ntfy.call_count == 3


@respx.mock
def test_one_dead_list_alerts_but_the_run_is_ok(settings):
    _mock_web(_config(["84839422", "555"]))
    settings.ntfy_topic = "tp-test"
    ntfy = respx.post(NTFY).mock(return_value=httpx.Response(200))
    report = run_collect_x(settings, _api(), _client([], fail={"555": XListError("gone")}), dry_run=False, now=NOW)
    assert report.status == "ok" and report.lists_ok == 1
    assert ntfy.call_count == 1 and ntfy.calls[0].request.headers["Priority"] == "default"
    assert "list 555 (india): gone" in ntfy.calls[0].request.content.decode()


@respx.mock
def test_lists_that_answer_but_look_dead_alert_high(settings):
    _mock_web()
    settings.ntfy_topic = "tp-test"
    ntfy = respx.post(NTFY).mock(return_value=httpx.Response(200))
    stale = NOW + timedelta(days=3)
    report = run_collect_x(settings, _api(), _client([]), dry_run=False, now=stale)
    assert report.status == "ok" and report.lists_ok == 1
    req = ntfy.calls[0].request
    assert req.headers["Title"] == "X collector: no list looks healthy" and req.headers["Priority"] == "high"


@respx.mock
def test_rate_limit_stops_asking_x_for_this_run(settings):
    _mock_web(_config(["84839422", "555"]))
    calls = []
    client = _client(calls, fail={"84839422": XRateLimited("http 429")})
    report = run_collect_x(settings, _api(), client, dry_run=False, now=NOW)
    assert calls == ["https://syndication.twitter.com/srv/timeline-list/list-id/84839422"]
    assert report.status == "failed" and any("rate-limited" in w for w in report.warnings)


def _tweets(*created: str):
    return {
        "status": "success",
        "data": {
            "tweets": [
                {"id": str(900 + i), "text": f"post {i}", "createdAt": c, "author": {"userName": "HamidMirPAK"}}
                for i, c in enumerate(created)
            ]
        },
    }


@respx.mock
def test_quiet_handle_costs_one_fallback_call_a_day(settings):
    _, _, _, seen = _mock_web(_config(hamid_last_post=NOW - timedelta(days=3)))
    settings.twitterapi_io_key = "k"
    paid = respx.get(TWITTERAPI).mock(return_value=httpx.Response(200, json=_tweets("Sun Sep 20 08:00:00 +0000 2026")))

    report = run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW)
    assert paid.call_count == 1 and report.fallback_handles == ["HamidMirPAK"]
    hamid = [json.loads(c.request.content) for c in seen.calls if "/handles/5/" in str(c.request.url)]
    assert hamid == [{"fallback_used": True, "last_post_at": "2026-09-20T08:00:00+00:00"}]

    # the server now says the handle last posted on the 20th, still > 24 h ago; the next runs must not pay again
    for minutes in (30, 60, 23 * 60):
        report = run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW + timedelta(minutes=minutes))
        assert report.fallback_handles == []
    assert paid.call_count == 1
    run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW + timedelta(hours=24, minutes=5))
    assert paid.call_count == 2


@respx.mock
def test_empty_fallback_is_recorded_and_not_retried_every_run(settings):
    _, _, _, seen = _mock_web(_config(hamid_last_post=NOW - timedelta(days=3)))
    settings.twitterapi_io_key = "k"
    paid = respx.get(TWITTERAPI).mock(
        return_value=httpx.Response(200, json={"status": "error", "msg": "User not found"})
    )
    run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW)
    run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW + timedelta(minutes=30))
    assert paid.call_count == 1
    hamid = [json.loads(c.request.content) for c in seen.calls if "/handles/5/" in str(c.request.url)]
    assert hamid == [{"fallback_used": True}]


@respx.mock
def test_fallback_server_error_is_retried_next_run(settings):
    _mock_web(_config(hamid_last_post=NOW - timedelta(days=3)))
    settings.twitterapi_io_key = "k"
    paid = respx.get(TWITTERAPI).mock(side_effect=[httpx.Response(502), httpx.Response(200, json=_tweets())])
    run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW)
    report = run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW + timedelta(minutes=30))
    assert paid.call_count == 2 and report.fallback_handles == ["HamidMirPAK"]


@respx.mock
def test_fallback_out_of_credit_stops_and_alerts(settings):
    cfg = json.loads(_config(hamid_last_post=NOW - timedelta(days=3)))
    cfg["handles"][1]["last_post_at"] = (NOW - timedelta(days=2)).isoformat()
    cfg["handles"].append(
        {"id": 7, "group_id": 1, "platform": "x", "handle": "Quiet", "last_post_at": cfg["handles"][1]["last_post_at"]}
    )
    _mock_web(json.dumps(cfg))
    settings.twitterapi_io_key = "k"
    settings.ntfy_topic = "tp-test"
    ntfy = respx.post(NTFY).mock(return_value=httpx.Response(200))
    paid = respx.get(TWITTERAPI).mock(return_value=httpx.Response(402, json={"msg": "insufficient credits"}))
    report = run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW)
    assert paid.call_count == 1 and report.status == "ok"
    assert ntfy.call_count == 1 and "out of credit" in ntfy.calls[0].request.content.decode()
    # nothing was recorded as asked, so once credit is back the handles are tried again
    paid.mock(return_value=httpx.Response(200, json=_tweets()))
    report = run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW + timedelta(minutes=30))
    assert sorted(report.fallback_handles) == ["HamidMirPAK", "Quiet"]


@respx.mock
def test_crash_is_alerted_and_recorded(settings):
    _, fin, _, _ = _mock_web()
    respx.post(f"{BASE}/api/worker/posts").mock(return_value=httpx.Response(400, json={"error": "bad posts"}))
    settings.ntfy_topic = "tp-test"
    ntfy = respx.post(NTFY).mock(return_value=httpx.Response(200))
    try:
        run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW)
    except Exception as e:  # noqa: BLE001
        assert "bad posts" in str(e)
    else:
        raise AssertionError("expected the API error to propagate")
    assert json.loads(fin.calls[-1].request.content)["status"] == "failed"
    assert ntfy.call_count == 1 and ntfy.calls[0].request.headers["Title"] == "X collector crashed"


@respx.mock
def test_unreadable_paid_answer_is_not_bought_again_every_run(settings):
    _, fin, _, _ = _mock_web(_config(hamid_last_post=NOW - timedelta(days=3)))
    settings.twitterapi_io_key = "k"
    paid = respx.get(TWITTERAPI).mock(
        side_effect=[
            httpx.Response(200, text="<html>not json</html>"),
            httpx.Response(200, json={"status": "success", "data": [{"tweets": "moved"}]}),
        ]
    )
    report = run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW)
    assert report.status == "ok" and any("unreadable" in w for w in report.warnings)
    assert json.loads(fin.calls[-1].request.content)["status"] == "ok"
    for minutes in (30, 60):
        run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW + timedelta(minutes=minutes))
    assert paid.call_count == 1
    # a day on it is asked again; an answer of an unexpected shape reads as no posts, not a crash
    report = run_collect_x(settings, _api(), _client([]), dry_run=False, now=NOW + timedelta(hours=24, minutes=5))
    assert paid.call_count == 2 and report.status == "ok" and report.fallback_handles == ["HamidMirPAK"]


@respx.mock
def test_an_interrupt_closes_the_run_row(settings):
    runs, fin, posts, seen = _mock_web()
    stop = {"84839422": KeyboardInterrupt()}
    with pytest.raises(KeyboardInterrupt):
        run_collect_x(settings, _api(), _client([], fail=stop), dry_run=False, now=NOW)
    body = json.loads(fin.calls[0].request.content)
    assert body["status"] == "failed" and "interrupted" in body["error"]  # not left "running"
