import json
from datetime import UTC, datetime

import httpx
import pytest
import respx

from conftest import config_json
from teenpehr.api import ApiError, WorkerApi
from teenpehr.models import (
    EditionGroupIn,
    EditionIn,
    ItemIn,
    PostIn,
    RunFinish,
    RunSourceResult,
    SourceRef,
    StoryIn,
)

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


@respx.mock
def test_get_edition(api):
    route = respx.get(f"{BASE}/api/worker/editions/2026-09-23/subh")
    route.mock(return_value=httpx.Response(404, json={"error": "not found"}))
    assert api.get_edition("2026-09-23", "subh") is None
    route.mock(return_value=httpx.Response(405))  # a web app older than the route: unknown, not fatal
    assert api.get_edition("2026-09-23", "subh") is None
    route.mock(return_value=httpx.Response(200, json={"edition_id": 7, "status": "review", "groups": ["pakistan"]}))
    st = api.get_edition("2026-09-23", "subh")
    assert st.edition_id == 7 and st.status == "review" and st.groups == ["pakistan"]
    route.mock(return_value=httpx.Response(401, json={"error": "bad token"}))
    with pytest.raises(ApiError):
        api.get_edition("2026-09-23", "subh")


@respx.mock
def test_skipped_run_sends_a_null_model(api):
    fin = respx.patch(f"{BASE}/api/worker/runs/9").mock(
        return_value=httpx.Response(200, json={"ok": True, "already": True})
    )
    api.finish_run(9, RunFinish(status="skipped", error="daily budget reached"))
    body = fin.calls[0].request.content
    assert b'"status":"skipped"' in body.replace(b" ", b"") and b'"model":null' in body.replace(b" ", b"")


# ---- sources removed in the admin mid-run, and non-idempotent POST /runs ---------------------------
def _unknown(ids):
    return httpx.Response(400, json={"error": f"unknown source ids: {ids}", "issues": {"sources": ids}})


@respx.mock
def test_finish_run_drops_results_for_removed_sources_and_still_finishes(api):
    fin = respx.patch(f"{BASE}/api/worker/runs/7")
    fin.side_effect = [_unknown([11]), httpx.Response(200, json={"ok": True})]
    api.finish_run(
        7,
        RunFinish(
            status="ok", sources=[RunSourceResult(source_id=10, ok=True), RunSourceResult(source_id=11, ok=False)]
        ),
    )
    sent = [s["source_id"] for s in json.loads(fin.calls[1].request.content)["sources"]]
    assert fin.call_count == 2 and sent == [10]


@respx.mock
def test_a_plain_400_on_finish_is_raised(api):
    respx.patch(f"{BASE}/api/worker/runs/7").mock(return_value=httpx.Response(400, json={"error": "invalid"}))
    with pytest.raises(ApiError):
        api.finish_run(7, RunFinish(status="ok"))


@respx.mock
def test_items_of_removed_sources_are_left_out(api):
    route = respx.post(f"{BASE}/api/worker/items")
    ok = httpx.Response(200, json={"items": [{"url_canonical": "a.test/1", "id": 1, "is_new": True}]})
    route.side_effect = [_unknown([11]), ok]
    items = [
        ItemIn(source_id=10, url="https://a.test/1", url_canonical="a.test/1", title="A", content_hash="h" * 16),
        ItemIn(source_id=11, url="https://b.test/1", url_canonical="b.test/1", title="B", content_hash="h" * 16),
    ]
    out = api.post_items(3, items)
    assert [o.id for o in out] == [1]
    assert [i["source_id"] for i in json.loads(route.calls[1].request.content)["items"]] == [10]


@respx.mock
def test_existing_items_come_back_with_what_was_stored(api):
    respx.post(f"{BASE}/api/worker/items").mock(
        return_value=httpx.Response(
            200,
            json={
                "items": [
                    {
                        "url_canonical": "a.test/1",
                        "id": 1,
                        "is_new": False,
                        "stored": {"title": "First headline", "text": "t", "published_at": None},
                    },
                    {"url_canonical": "a.test/2", "id": 2, "is_new": True},
                ]
            },
        )
    )
    items = [
        ItemIn(
            source_id=10, url=f"https://a.test/{n}", url_canonical=f"a.test/{n}", title="Edited", content_hash="h" * 16
        )
        for n in (1, 2)
    ]
    out = api.post_items(3, items)
    assert out[0].stored.title == "First headline" and out[1].stored is None


@respx.mock
def test_start_run_is_not_replayed_after_a_read_timeout(api):
    route = respx.post(f"{BASE}/api/worker/runs")
    route.side_effect = [httpx.ReadTimeout("slow"), httpx.Response(201, json={"id": 5})]
    with pytest.raises(httpx.ReadTimeout):
        api.start_run("edition", "2026-09-23", "subh")
    assert route.call_count == 1  # the server may have inserted the row already


@respx.mock
def test_start_run_is_retried_when_the_request_never_left(api):
    route = respx.post(f"{BASE}/api/worker/runs")
    route.side_effect = [httpx.ConnectError("refused"), httpx.Response(201, json={"id": 5})]
    assert api.start_run("edition") == 5 and route.call_count == 2


@respx.mock
def test_read_backs_carry_the_image_fields(api):
    """GET /posts gives each post's stored media and GET /items each item's image_url (docs/API.md, D6):
    a cited post's photo and a 304 feed's read-back item both keep their image candidate."""
    respx.get(f"{BASE}/api/worker/posts").mock(
        return_value=httpx.Response(
            200,
            json={
                "posts": [
                    {
                        "id": 7,
                        "handle_id": None,
                        "author_handle": "h",
                        "author_name": "H",
                        "text": "t",
                        "url": "https://x.com/h/status/7",
                        "posted_at": "2026-09-28T10:00:00Z",
                        "is_repost": False,
                        "platform": "x",
                        "media": [
                            {"type": "video", "url": "https://v.test/1.mp4"},
                            {"type": "photo", "url": "https://pbs.test/a.jpg", "alt": "A"},
                            {"junk": 1},
                        ],
                    },
                    {
                        "id": 8,
                        "handle_id": None,
                        "author_handle": "h",
                        "author_name": "",
                        "text": "t",
                        "url": "https://x.com/h/status/8",
                        "posted_at": "2026-09-28T10:00:00Z",
                        "is_repost": False,
                        "media": None,
                    },
                ]
            },
        )
    )
    respx.get(f"{BASE}/api/worker/items").mock(
        return_value=httpx.Response(
            200,
            json={
                "items": [
                    {
                        "id": 9,
                        "source_id": 1,
                        "url": "https://dawn.com/news/1",
                        "url_canonical": "dawn.com/news/1",
                        "content_hash": "c",
                        "title": "T",
                        "text": "",
                        "published_at": None,
                        "lang": "en",
                        "image_url": "https://i.dawn.com/a.jpg",
                    }
                ]
            },
        )
    )
    posts = api.get_posts(datetime(2026, 9, 28, tzinfo=UTC))
    assert [m.type for m in posts[0].media] == ["video", "photo"] and posts[1].media is None
    from teenpehr.images import post_ref

    ref = post_ref(posts[0])
    assert ref.photo_url == "https://pbs.test/a.jpg" and ref.photo_alt == "A" and post_ref(posts[1]).photo_url is None
    assert api.get_items(datetime(2026, 9, 28, tzinfo=UTC))[0].image_url == "https://i.dawn.com/a.jpg"


@respx.mock
def test_a_run_less_edition_sends_a_null_run_id_the_server_accepts(api):
    """EditionIn.run_id None goes as null; web/lib/contracts.ts accepts null or absent (it refused null once)."""
    put = respx.put(f"{BASE}/api/worker/editions/2000-01-01/subh").mock(
        return_value=httpx.Response(200, json={"edition_id": 1, "status": "draft", "stories": []})
    )
    api.put_edition("2000-01-01", "subh", EditionIn(groups=[]))
    assert json.loads(put.calls[0].request.content)["run_id"] is None
