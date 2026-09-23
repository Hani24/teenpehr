from datetime import UTC, datetime

import httpx
import pytest
import respx

from conftest import config_json
from teenpehr.api import ApiError, WorkerApi
from teenpehr.models import EditionGroupIn, EditionIn, ItemIn, PostIn, RunFinish, SourceRef, StoryIn

BASE = "http://web.test"


@pytest.fixture
def api():
    a = WorkerApi(BASE, "tok", retries=3, backoff=0)
    yield a
    a.close()


@respx.mock
def test_all_routes(api):
    respx.get(f"{BASE}/api/worker/health").mock(return_value=httpx.Response(200, json={"ok": True, "time": "x"}))
    cfg = respx.get(f"{BASE}/api/worker/config").mock(return_value=httpx.Response(200, text=config_json()))
    respx.post(f"{BASE}/api/worker/runs").mock(return_value=httpx.Response(201, json={"id": 42}))
    fin = respx.patch(f"{BASE}/api/worker/runs/42").mock(return_value=httpx.Response(200, json={}))
    items = respx.post(f"{BASE}/api/worker/items").mock(
        return_value=httpx.Response(200, json={"items": [{"url_canonical": "dawn.com/1", "id": 9001, "is_new": False}]})
    )
    posts = respx.post(f"{BASE}/api/worker/posts").mock(
        return_value=httpx.Response(
            200, json={"posts": [{"platform_id": "1", "id": 501, "is_new": True, "handle_id": 5}]}
        )
    )
    respx.get(f"{BASE}/api/worker/posts").mock(
        return_value=httpx.Response(
            200,
            json={
                "posts": [
                    {
                        "id": 501,
                        "handle_id": 5,
                        "author_handle": "h",
                        "text": "t",
                        "url": "https://x.com/h/status/1",
                        "posted_at": "2026-09-23T01:00:00+00:00",
                    }
                ]
            },
        )
    )
    respx.get(f"{BASE}/api/worker/items").mock(return_value=httpx.Response(200, json={"items": []}))
    put = respx.put(f"{BASE}/api/worker/editions/2026-09-23/subh").mock(
        return_value=httpx.Response(
            200, json={"edition_id": 7, "status": "draft", "stories": [{"order": 0, "group": "pakistan", "id": 3001}]}
        )
    )
    pub = respx.post(f"{BASE}/api/worker/editions/2026-09-23/subh/publish").mock(
        return_value=httpx.Response(
            200, json={"status": "published", "published_at": "2026-09-23T02:00:00+00:00", "url": "/en/2026-09-23/subh"}
        )
    )
    glos = respx.post(f"{BASE}/api/worker/glossary").mock(
        return_value=httpx.Response(200, json={"added": 1, "skipped": 0})
    )
    seen = respx.post(f"{BASE}/api/worker/handles/5/seen").mock(return_value=httpx.Response(200, json={"ok": True}))

    assert api.health()["ok"] is True
    c = api.config()
    assert cfg.called and c.groups[0].slug == "pakistan" and c.sources[2].route == "germany"
    assert api.start_run("edition", "2026-09-23", "subh") == 42
    api.finish_run(42, RunFinish(status="ok", cost_usd=0.5))
    assert fin.calls[0].request.headers["authorization"] == "Bearer tok"
    out = api.post_items(
        42,
        [
            ItemIn(
                source_id=10, url="https://www.dawn.com/1", url_canonical="dawn.com/1", title="T", content_hash="h" * 8
            )
        ],
    )
    assert out[0].id == 9001 and out[0].is_new is False
    assert b'"run_id": 42' in items.calls[0].request.content or b'"run_id":42' in items.calls[0].request.content
    po = api.post_posts(
        43,
        [
            PostIn(
                platform_id="1",
                author_handle="h",
                text="t",
                url="https://x.com/h/status/1",
                posted_at=datetime(2026, 9, 23, tzinfo=UTC),
            )
        ],
    )
    assert po[0].handle_id == 5 and posts.called
    assert api.get_posts(datetime(2026, 9, 23, tzinfo=UTC), group="pakistan")[0].id == 501
    assert api.get_items(datetime(2026, 9, 23, tzinfo=UTC), group="pakistan") == []
    ed = EditionIn(
        groups=[
            EditionGroupIn(
                group="pakistan",
                stories=[
                    StoryIn(order=0, title_en="T", summary_en="S", sources=[SourceRef(item_id=9001, is_primary=True)])
                ],
            )
        ]
    )
    assert api.put_edition("2026-09-23", "subh", ed).edition_id == 7 and put.called
    r = api.publish("2026-09-23", "subh", notify=False)
    assert (
        r.status == "published"
        and b'"notify": false' in pub.calls[0].request.content.replace(b" ", b"")
        or b'"notify":false' in pub.calls[0].request.content
    )
    assert api.add_glossary([{"term_en": "A", "term_ur": "ا", "kind": "other"}])["added"] == 1 and glos.called
    api.handle_seen(5, datetime(2026, 9, 23, tzinfo=UTC), fallback_used=True)
    assert seen.called


@respx.mock
def test_401_is_not_retried(api):
    route = respx.get(f"{BASE}/api/worker/config").mock(return_value=httpx.Response(401, json={"error": "bad token"}))
    with pytest.raises(ApiError) as ei:
        api.config()
    assert ei.value.status == 401 and route.call_count == 1


@respx.mock
def test_5xx_is_retried_then_succeeds(api):
    route = respx.get(f"{BASE}/api/worker/health")
    route.side_effect = [httpx.Response(503), httpx.Response(200, json={"ok": True})]
    assert api.health()["ok"] is True
    assert route.call_count == 2


@respx.mock
def test_400_carries_issues(api):
    respx.put(f"{BASE}/api/worker/editions/2026-09-23/subh").mock(
        return_value=httpx.Response(400, json={"error": "invalid", "issues": [{"path": ["groups"]}]})
    )
    with pytest.raises(ApiError) as ei:
        api.put_edition("2026-09-23", "subh", EditionIn(groups=[EditionGroupIn(group="x", stories=[])]))
    assert ei.value.issues == [{"path": ["groups"]}]
