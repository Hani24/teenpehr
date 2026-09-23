import json

import httpx
import respx

from conftest import config_json, fixture_text
from teenpehr.api import WorkerApi
from teenpehr.collect_x import run_collect_x
from teenpehr.social.x_list import XListClient

BASE = "http://web.test"


def _client(calls):
    def fetch(url, headers):
        calls.append(url)
        assert headers["Accept"].startswith("text/html")
        return fixture_text("x_list_84839422.html")

    return XListClient(fetch, spacing_s=0)


@respx.mock
def test_collect_x_posts_and_marks_handles(settings):
    respx.get(f"{BASE}/api/worker/config").mock(return_value=httpx.Response(200, text=config_json()))
    runs = respx.post(f"{BASE}/api/worker/runs").mock(return_value=httpx.Response(201, json={"id": 77}))
    fin = respx.patch(f"{BASE}/api/worker/runs/77").mock(return_value=httpx.Response(200, json={}))

    def posts_cb(request):
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "posts": [
                    {
                        "platform_id": p["platform_id"],
                        "id": 100 + n,
                        "is_new": n % 2 == 0,
                        "handle_id": 6 if p["author_handle"] == "Movies" else None,
                    }
                    for n, p in enumerate(body["posts"])
                ]
            },
        )

    posts = respx.post(f"{BASE}/api/worker/posts").mock(side_effect=posts_cb)
    seen = respx.post(f"{BASE}/api/worker/handles/6/seen").mock(return_value=httpx.Response(200, json={"ok": True}))
    calls = []
    report = run_collect_x(settings, WorkerApi(BASE, "tok", backoff=0), _client(calls), dry_run=False)
    assert calls == ["https://syndication.twitter.com/srv/timeline-list/list-id/84839422"]
    assert report.lists == 1 and report.posts == 97 and report.new_posts > 0 and report.status == "ok"
    assert runs.called and posts.called and seen.called
    assert json.loads(fin.calls[0].request.content)["status"] == "ok"


@respx.mock
def test_collect_x_dry_run_makes_no_writes(settings):
    respx.get(f"{BASE}/api/worker/config").mock(return_value=httpx.Response(200, text=config_json()))
    runs = respx.post(f"{BASE}/api/worker/runs").mock(return_value=httpx.Response(201, json={"id": 77}))
    posts = respx.post(f"{BASE}/api/worker/posts").mock(return_value=httpx.Response(200, json={"posts": []}))
    report = run_collect_x(settings, WorkerApi(BASE, "tok", backoff=0), _client([]), dry_run=True)
    assert report.posts == 97 and not runs.called and not posts.called
