"""The image step inside an edition run (D6): images are uploaded and set on the stories before the
PUT, only from cited items or posts; a dry run writes them to out/ and uploads nothing; IMAGES=0
turns the step off; an image problem never costs a story or the edition."""

from __future__ import annotations

import io
import json
import zlib
from pathlib import Path

import httpx
import respx
from PIL import Image, ImageDraw

from teenpehr.api import WorkerApi
from teenpehr.fetch.http import FetchResult
from teenpehr.pipeline import EditionRun
from test_pipeline import BASE, KHI, NOW, FakeFetcher, _fake_llm, _mock_api

ARTICLE_PREFIXES = ("https://jang.com.pk/news/", "https://www.geo.tv/latest/", "https://amu.tv/")


def pic(tag: str, w: int = 1200, h: int = 800) -> bytes:
    """A distinct JPEG per tag (its own colour), so no two stories share a picture by accident."""
    c = zlib.crc32(tag.encode())
    im = Image.linear_gradient("L").resize((w, h)).convert("RGB")
    ImageDraw.Draw(im).rectangle((w // 4, h // 4, w // 2, h // 2), fill=(c & 255, (c >> 8) & 255, (c >> 16) & 255))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return buf.getvalue()


class SiteFetcher(FakeFetcher):
    """The feeds of FakeFetcher, plus article pages that declare an og:image and the images themselves.
    `no_page` lists article URLs whose page is gone (404)."""

    def __init__(self, no_page: tuple[str, ...] = ()):
        super().__init__()
        self.no_page = no_page
        self.image_calls: list[tuple[str, str, dict]] = []

    def get(
        self,
        url,
        *,
        route="direct",
        headers=None,
        conditional=False,
        allow_fallback=True,
        max_bytes=0,
        follow_redirects=True,
        hard_limit=False,
    ):
        if url.endswith("/robots.txt"):
            return FetchResult(url=url, status=404, error="http 404", route_used=route)
        if url.startswith("https://img.test/") or url.startswith("https://pbs.twimg.com/"):
            self.image_calls.append((url, route, dict(headers or {})))
            return FetchResult(
                url=url,
                status=200,
                content=pic(url),
                headers={"content-type": "image/jpeg"},
                final_url=url,
                route_used=route,
            )
        if url.startswith(ARTICLE_PREFIXES) and not any(url.startswith(p) for p in self.no_page):
            slug = f"{zlib.crc32(url.encode()):08x}"
            page = f'<html><head><meta property="og:image" content="https://img.test/{slug}.jpg"></head></html>'
            return FetchResult(
                url=url,
                status=200,
                content=page.encode(),
                headers={"content-type": "text/html"},
                final_url=url,
                route_used=route,
            )
        return super().get(
            url,
            route=route,
            headers=headers,
            conditional=conditional,
            allow_fallback=allow_fallback,
            max_bytes=max_bytes,
        )


def _llm():
    llm = _fake_llm()
    llm.responses["image"] = {"graphic": False, "placeholder_or_logo": False}
    return llm


def _images_route():
    uploads: list[dict] = []

    def cb(request):
        body = json.loads(request.content)
        uploads.append(body)
        return httpx.Response(201, json={"image_id": 700 + len(uploads), "created": True})

    return respx.post(f"{BASE}/api/worker/images").mock(side_effect=cb), uploads


def _run(settings, fetcher, llm=None, *, dry_run=False):
    api = WorkerApi(BASE, "tok", backoff=0)
    return EditionRun(settings, api, llm or _llm(), fetcher, dry_run=dry_run, now=NOW.astimezone(KHI)).run()


@respx.mock
def test_live_run_uploads_cited_images_and_puts_their_ids(settings):
    settings.images = True
    runs, fin, items, put, pub, glos = _mock_api()
    outputs = respx.post(f"{BASE}/api/worker/runs/42/outputs").mock(return_value=httpx.Response(201, json={"ids": []}))
    route, uploads = _images_route()
    fetcher = SiteFetcher()
    llm = _llm()
    report = _run(settings, fetcher, llm)
    assert report.status == "ok" and route.called
    body = json.loads(put.calls[0].request.content)
    stories = [st for g in body["groups"] for st in g["stories"]]
    by_id = {700 + n: u for n, u in enumerate(uploads, 1)}
    assert stories and all(st["image_id"] in by_id for st in stories)
    for st in stories:
        up = by_id[st["image_id"]]
        assert up["item_id"] in {r["item_id"] for r in st["sources"]}  # I1: only what the story cites
        assert up["graphic"] is False and up["alt"] is None and up["credit"]
    # one vision call per image, with the image attached, counted in the run's usage; each verdict is kept
    # as a stage "image" output, in a request of its own after the editorial passes' outputs
    checks = [c for c in llm.calls if c["task"].startswith("image:")]
    assert len(checks) == len(uploads) and all(len(c["images"]) == 1 for c in checks)
    assert report.passes["image_check"]["calls"] == len(uploads)
    assert json.loads(fin.calls[-1].request.content)["cost_usd"] >= 0.01 * (3 + len(uploads))
    sent = [[o for o in json.loads(c.request.content)["outputs"]] for c in outputs.calls]
    assert len(sent) == 2 and {o["stage"] for o in sent[0]} <= {"curate", "urdu", "qa"}
    verdicts = sent[1]
    assert len(verdicts) == len(uploads) and {o["stage"] for o in verdicts} == {"image"}
    shown = {o["output"]["image_id"] for o in verdicts}
    assert shown == set(by_id) and all(o["output"]["shown"] and o["output"]["checked"] for o in verdicts)
    assert all(o["output"]["reason"] == "checked" and o["output"]["graphic"] is False for o in verdicts)
    assert all(o["output"]["sha256"] == by_id[o["output"]["image_id"]]["sha256"] for o in verdicts)
    assert all(o["group"] and o["cost_usd"] > 0 and o["output"]["source_url"].startswith("http") for o in verdicts)
    # every image request named its article as Referer and went on the article's route
    assert fetcher.image_calls and all(h["Referer"].startswith(ARTICLE_PREFIXES) for _, _, h in fetcher.image_calls)
    amu = [r for u, r, h in fetcher.image_calls if h["Referer"].startswith("https://amu.tv/")]
    assert amu and set(amu) == {"germany"}


@respx.mock
def test_a_story_whose_items_have_no_image_takes_its_posts_photo(settings):
    settings.images = True
    _, _, _, put, _, _ = _mock_api()
    post = {
        "id": 501,
        "handle_id": 5,
        "author_handle": "HamidMirPAK",
        "author_name": "Hamid Mir",
        "text": "Breaking: meeting underway",
        "url": "https://x.com/HamidMirPAK/status/1",
        "posted_at": "2026-09-23T07:30:00+00:00",
        "media": [{"type": "photo", "url": "https://pbs.twimg.com/media/abc.jpg", "alt": "The meeting room"}],
    }
    respx.get(f"{BASE}/api/worker/posts").mock(return_value=httpx.Response(200, json={"posts": [post]}))
    route, uploads = _images_route()
    fetcher = SiteFetcher(no_page=("https://jang.com.pk/news/", "https://www.geo.tv/latest/"))
    assert _run(settings, fetcher).status == "ok"
    body = json.loads(put.calls[0].request.content)
    s1 = next(g for g in body["groups"] if g["group"] == "pakistan")["stories"][0]
    up = next(u for n, u in enumerate(uploads, 1) if 700 + n == s1["image_id"])
    assert up["post_id"] == 501 and up["item_id"] is None and up["source_id"] is None
    assert up["credit"] == "Hamid Mir" and up["alt"] == "The meeting room"
    s2 = next(g for g in body["groups"] if g["group"] == "pakistan")["stories"][1]
    assert s2["image_id"] is None  # no page, no post: no image, and the story is still there


@respx.mock
def test_dry_run_writes_images_to_out_and_uploads_nothing(settings):
    settings.images = True
    _mock_api()
    route, _ = _images_route()
    report = _run(settings, SiteFetcher(), dry_run=True)
    assert report.status == "dry-run" and not route.called
    out = json.loads(Path(report.out_file).read_text(encoding="utf-8"))
    assert out["images"] and out["images_dir"].endswith("2026-09-23-dopahar/images")
    for m in out["images"]:
        assert m["image_id"] is None and len(m["sha256"]) == 64 and m["checked"] and m["files"]
        assert all(Path(f).is_file() and Path(f).parent == Path(out["images_dir"]) for f in m["files"])
    assert all(st["image_id"] is None for g in out["edition"]["groups"] for st in g["stories"])


@respx.mock
def test_images_off_fetches_and_uploads_no_image(settings):
    settings.images = False
    _, _, _, put, _, _ = _mock_api()
    route, _ = _images_route()
    fetcher = SiteFetcher()
    llm = _llm()
    report = _run(settings, fetcher, llm)
    assert report.status == "ok" and not route.called and fetcher.image_calls == []
    assert "image_check" not in report.passes and not any(c["task"].startswith("image:") for c in llm.calls)
    body = json.loads(put.calls[0].request.content)
    assert all(st["image_id"] is None for g in body["groups"] for st in g["stories"])


@respx.mock
def test_an_edition_put_refused_over_images_goes_again_without_them(settings):
    settings.images = True
    _, _, _, put, pub, _ = _mock_api()
    _images_route()
    refused = httpx.Response(400, json={"error": "image not from an item or post its story cites", "issues": []})
    ok = httpx.Response(200, json={"edition_id": 7, "status": "draft", "stories": []})
    put.mock(side_effect=[refused, ok])
    report = _run(settings, SiteFetcher())
    assert report.status == "ok" and pub.called and put.call_count == 2
    first, second = (json.loads(c.request.content) for c in put.calls)
    assert any(st["image_id"] for g in first["groups"] for st in g["stories"])
    assert all(st["image_id"] is None for g in second["groups"] for st in g["stories"])


@respx.mock
def test_an_image_step_crash_never_fails_the_run(settings, monkeypatch):
    settings.images = True
    _, _, _, put, _, _ = _mock_api()
    from teenpehr.images import ImagePicker

    def boom(self, *a, **kw):
        raise RuntimeError("disk full")

    monkeypatch.setattr(ImagePicker, "deliver", boom)
    _images_route()
    report = _run(settings, SiteFetcher())
    assert report.status == "ok"
    body = json.loads(put.calls[0].request.content)
    assert all(st["image_id"] is None for g in body["groups"] for st in g["stories"])
