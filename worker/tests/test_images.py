"""Publisher images (decision D6): finding a page's image, cleaning a download, choosing one per story
from what it cites, the vision check's fail-safe, and delivery. Fixture images are made with Pillow
here; nothing touches the network (the SSRF tests use local servers, as test_fetch_guard does)."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import struct
import zlib

import httpx
import pytest
import respx
from PIL import Image, ImageCms

from teenpehr.api import WorkerApi
from teenpehr.fetch import http
from teenpehr.fetch.article import ArticleFetcher
from teenpehr.fetch.http import FetchResult
from teenpehr.images import (
    ImagePicker,
    ImageRejected,
    ItemRef,
    PostRef,
    item_ref,
    page_images,
    post_ref,
    process_image,
    reused_urls,
    usable_image_url,
)
from teenpehr.images import picker as picker_mod
from teenpehr.images.process import MAX_PIXELS, variant_widths, webp_chunks
from teenpehr.llm import FakeLLM, LLMError
from teenpehr.models import ItemFetch, ItemIn, PostMedia, PostRecord, Source, SourceRef, StoryIn
from test_fetch_guard import _pretend_public, servers  # noqa: F401 - `servers` is a fixture

BASE = "http://web.test"


# ---- fixture images ----------------------------------------------------------------------------------
def photo(w: int = 1200, h: int = 800, fmt: str = "JPEG", mode: str = "RGB", seed: int = 1, **save) -> bytes:
    """A photo-like picture: a gradient with a block, so it has more than one colour."""
    im = Image.linear_gradient("L").resize((w, h)).convert(mode if mode != "CMYK" else "RGB")
    if mode == "RGB":
        im = Image.merge(
            "RGB", (im.getchannel(0), im.getchannel(0).point(lambda x: (x * seed) % 256), im.getchannel(0))
        )
    elif mode == "CMYK":
        im = im.convert("CMYK")
    else:
        im = im.convert(mode)
    buf = io.BytesIO()
    im.save(buf, fmt, **save)
    return buf.getvalue()


def png_claiming(w: int, h: int) -> bytes:
    """A tiny PNG whose header claims w×h pixels (a decompression bomb's shape, without the bomb)."""
    raw = photo(8, 8, "PNG")
    ihdr = raw.index(b"IHDR")
    body = struct.pack(">II", w, h) + raw[ihdr + 12 : ihdr + 17]
    crc = struct.pack(">I", zlib.crc32(b"IHDR" + body) & 0xFFFFFFFF)
    return raw[: ihdr + 4] + body + crc + raw[ihdr + 21 :]


# ---- which URLs and which page images ---------------------------------------------------------------------
@pytest.mark.parametrize(
    ("url", "ok"),
    [
        ("https://images.dawn.com/news/2026/09/lead.jpg", True),
        ("https://i.ytimg.com/vi/abc/hqdefault.jpg", True),  # a video still, not a "default" picture
        ("data:image/png;base64,iVBORw0KGgo=", False),
        ("https://site.test/img/chart.svg", False),
        ("https://site.test/img/chart.SVGZ", False),
        ("ftp://site.test/a.jpg", False),
        ("/relative/a.jpg", False),
        ("https://news.google.com/api/attachments/abc", False),
        ("https://site.test/static/dawn-default.jpg", False),
        ("https://site.test/static/logo.png", False),
        ("https://site.test/assets/placeholder-image.png", False),
        ("https://site.test/" + "a" * 2100 + ".jpg", False),
        ("https://site.test/a.jpg\r\nX-Injected: 1", False),  # a control character: never a request line
        ("https://site.test/a\x00.jpg", False),
    ],
)
def test_usable_image_urls(url, ok):
    assert usable_image_url(url) is ok


def test_page_images_in_order_with_relative_urls_alt_and_rejections():
    page = b"""<!doctype html><html><head>
    <base href="https://cdn.site.test/base/">
    <meta property="og:image" content="data:image/png;base64,AAAA">
    <meta property="og:image" content="/img/lead.jpg">
    <meta property="og:image:alt" content="Protesters outside the Karachi Press Club">
    <meta property="og:image" content="https://site.test/chart.svg">
    <meta property="og:image" content="https://site.test/small.jpg"><meta property="og:image:width" content="150">
    <meta name="twitter:image" content="https://site.test/tw.jpg">
    <meta name="twitter:image:alt" content="Twitter alt">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle",
      "image":{"@type":"ImageObject","url":"https://site.test/ld.jpg","caption":"Rescue workers in Swat"}}</script>
    <script type="application/ld+json">{"@type":"Organization","logo":"https://site.test/org.jpg",
      "image":"https://site.test/org-image.jpg"}</script>
    <link rel="image_src" href="rel/src.jpg">
    </head><body><p>text</p></body></html>"""
    got = page_images(page, "https://www.site.test/news/1")
    assert [(p.url, p.alt) for p in got] == [
        ("https://cdn.site.test/img/lead.jpg", "Protesters outside the Karachi Press Club"),
        ("https://site.test/tw.jpg", "Twitter alt"),
        ("https://site.test/ld.jpg", "Rescue workers in Swat"),
        ("https://cdn.site.test/base/rel/src.jpg", None),
    ]


def test_page_images_resolve_against_the_page_and_survive_junk():
    page = '<?xml version="1.0" encoding="utf-8"?><html><head><meta property="og:image" content="../i/a.jpg"></head></html>'
    assert [p.url for p in page_images(page, "https://site.test/news/2026/story")] == ["https://site.test/news/i/a.jpg"]
    assert page_images(b"", "https://site.test/") == []
    assert page_images(b"\xff\xfe not html", "https://site.test/") == []
    bad_ld = b'<html><head><script type="application/ld+json">{not json</script></head></html>'
    assert page_images(bad_ld, "https://site.test/") == []
    deep = b"[" * 50_000 + b"]" * 50_000  # nesting that exhausts the JSON parser's recursion
    page = (
        b'<html><head><script type="application/ld+json">'
        + deep
        + b'</script><meta property="og:image" content="/x.jpg"></head></html>'
    )
    assert [p.url for p in page_images(page, "https://site.test/a")] == ["https://site.test/x.jpg"]


# ---- cleaning a download ------------------------------------------------------------------------------------
def test_variants_are_480_and_960_never_upscaled():
    assert variant_widths(1600) == [480, 960]
    assert variant_widths(700) == [480, 700]
    assert variant_widths(400) == [400]
    p = process_image(photo(1600, 900))
    assert (p.width, p.height) == (1600, 900) and [(v.w, v.h) for v in p.variants] == [(480, 270), (960, 540)]
    p2 = process_image(photo(640, 427))
    assert [(v.w, v.h) for v in p2.variants] == [(480, 320), (640, 427)]
    for v in p.variants + p2.variants:
        with Image.open(io.BytesIO(v.data)) as im:
            assert im.format == "WEBP" and im.size == (v.w, v.h) and not getattr(im, "is_animated", False)
    assert p.color.startswith("#") and len(p.color) == 7 and p.source_format == "JPEG"


def test_exif_xmp_and_icc_are_stripped_and_orientation_applied():
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: rotate 90° clockwise to view
    exif[0x013B] = "Photographer Name"  # Artist
    exif[0x8825] = {1: "N", 2: (33.0, 41.0, 0.0)}  # GPS IFD
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    raw = photo(1200, 800, exif=exif.tobytes(), icc_profile=icc, xmp=b"<x:xmpmeta>secret</x:xmpmeta>")
    with Image.open(io.BytesIO(raw)) as src:
        assert src.getexif().get(0x013B) == "Photographer Name" and src.info.get("icc_profile")
    p = process_image(raw)
    assert (p.width, p.height) == (800, 1200)  # upright: EXIF orientation applied before measuring
    for v in p.variants:
        assert webp_chunks(v.data) == ["VP8 "]  # simple lossy WebP: no VP8X, EXIF, XMP or ICCP chunk
        assert b"Photographer" not in v.data and b"secret" not in v.data
        with Image.open(io.BytesIO(v.data)) as im:
            assert not im.getexif() and "icc_profile" not in im.info and "xmp" not in im.info


def test_cmyk_palette_alpha_and_grey_images_become_rgb():
    for raw in (
        photo(900, 600, mode="CMYK"),
        photo(900, 600, "PNG", mode="P"),
        photo(900, 600, "PNG", mode="RGBA"),
        photo(900, 600, "PNG", mode="LA"),
        photo(900, 600, "GIF", mode="L"),
        photo(900, 600, "WEBP"),
    ):
        p = process_image(raw)
        assert [v.w for v in p.variants] == [480, 900]
        with Image.open(io.BytesIO(p.variants[0].data)) as im:
            assert im.mode == "RGB"


@pytest.mark.parametrize(
    ("data", "why"),
    [
        (b"", "empty"),
        (b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>', "SVG"),
        (b"<svg onload=alert(1)>", "SVG"),
        (b"<html>not an image</html>", "not a JPEG"),
        (photo(200, 150), "px wide"),  # a thumbnail
        (photo(299, 400), "px wide"),
        (photo(1200, 200), "shape"),  # a banner
        (photo(400, 1200), "shape"),  # a long graphic
        (photo(1200, 800)[:5000], "undecodable"),  # truncated
    ],
)
def test_unusable_files_are_rejected(data, why):
    with pytest.raises(ImageRejected, match=why):
        process_image(data)


def test_animated_images_are_rejected():
    frames = [Image.new("RGB", (600, 400), c) for c in ((255, 0, 0), (0, 0, 255))]
    for fmt in ("GIF", "WEBP"):
        buf = io.BytesIO()
        frames[0].save(buf, fmt, save_all=True, append_images=frames[1:], duration=100, loop=0)
        with pytest.raises(ImageRejected, match="animated"):
            process_image(buf.getvalue())


@pytest.mark.parametrize("size", [(7000, 7000), (30000, 30000), (25000, 100)])
def test_decompression_bombs_are_rejected_before_decoding(size):
    assert size[0] * size[1] > MAX_PIXELS or max(size) > 20000
    data = png_claiming(*size)
    assert len(data) < 200  # tiny on the wire, enormous once decoded
    with pytest.raises(ImageRejected, match="pixel guard|decompression bomb"):
        process_image(data)


# ---- the fetcher side -----------------------------------------------------------------------------------
class ImgFetcher:
    """A Fetcher stand-in: `routes[url]` is (status, content-type, body); robots.txt is absent (404)."""

    def __init__(self, routes: dict[str, tuple[int, str, bytes]] | None = None):
        self.routes = routes or {}
        self.calls: list[dict] = []

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
        self.calls.append(
            {
                "url": url,
                "route": route,
                "headers": dict(headers or {}),
                "hard_limit": hard_limit,
                "max_bytes": max_bytes,
                "allow_fallback": allow_fallback,
            }
        )
        status, ctype, body = self.routes.get(url, (404, "text/plain", b"no"))
        ok = 200 <= status < 300
        return FetchResult(
            url=url,
            status=status,
            content=body if ok else b"",
            headers={"content-type": ctype},
            final_url=url,
            route_used=route,
            error=None if ok else f"http {status}",
        )

    def cooldown_left(self, url):
        return 0.0

    def image_calls(self):
        return [c for c in self.calls if not c["url"].endswith("/robots.txt")]


def _picker(settings, fetcher, llm=None, *, reused=None, budget_ok=lambda: True):
    spent = {"ok": [], "failed": []}
    p = ImagePicker(
        settings,
        fetcher,
        ArticleFetcher(fetcher),
        llm or FakeLLM(responses={"image": {"graphic": False, "placeholder_or_logo": False}}),
        account=lambda res, task: spent["ok"].append((task, res.cost_usd)),
        account_failure=lambda e: spent["failed"].append(e.cost_usd),
        budget_ok=budget_ok,
        reused=reused,
    )
    return p, spent


def _item(db_id, url, *, urls=(), source_id=10, route="direct", kind="rss", credit="Dawn", fetched=False):
    return ItemRef(db_id, url, source_id, credit, route, kind, list(urls), fetched)


def _story(*item_ids, primary=None, posts=(), order=0):
    primary = item_ids[0] if primary is None else primary
    return StoryIn(
        order=order,
        title_en="T",
        summary_en="S",
        sources=[SourceRef(item_id=i, is_primary=i == primary) for i in item_ids],
        posts=list(posts),
    )


def _pick(p, story, items, posts=None, group="pakistan"):
    return asyncio.run(p.pick_all([(group, story)], items, posts or {}))


def test_candidates_come_from_cited_items_primary_first_then_posts():
    items = {1: _item(1, "https://a.test/1"), 2: _item(2, "https://a.test/2"), 3: _item(3, "https://a.test/3")}
    posts = {7: PostRef(7, "https://x.com/a/status/7", "A", "https://pbs.twimg.com/media/p.jpg")}
    st = _story(2, 1, primary=1, posts=[7])
    assert [(type(o).__name__, o.db_id) for o in ImagePicker.owners(st, items, posts)] == [
        ("ItemRef", 1),
        ("ItemRef", 2),
        ("PostRef", 7),
    ]  # item 3 is not cited: never a candidate


def test_primary_feed_image_is_used_with_the_article_as_referer(settings):
    f = ImgFetcher({"https://img.test/lead.jpg": (200, "image/jpeg", photo())})
    p, spent = _picker(settings, f)
    items = {1: _item(1, "https://dawn.test/news/1", urls=["https://img.test/lead.jpg"], route="germany")}
    (c,) = _pick(p, _story(1), items)
    assert c.cand.item.db_id == 1 and c.graphic is False and c.checked
    (call,) = f.image_calls()
    assert call["route"] == "germany" and call["hard_limit"] and call["max_bytes"] == 8 * 1024 * 1024
    hdrs = call["headers"]
    assert hdrs["Referer"] == "https://dawn.test/news/1" and hdrs["Accept"].startswith("image/")
    assert hdrs["Upgrade-Insecure-Requests"] is None and hdrs["Sec-Fetch-Dest"] == "image"
    assert [t for t, _ in spent["ok"]] == ["image:pakistan:0"]


def test_a_thumbnail_falls_back_to_the_pages_og_image_with_its_alt(settings):
    page = b'<html><head><meta property="og:image" content="/big.jpg"><meta property="og:image:alt" content="Flooded street"></head></html>'
    f = ImgFetcher(
        {
            "https://img.test/thumb.jpg": (200, "image/jpeg", photo(150, 100)),
            "https://dawn.test/news/1": (200, "text/html; charset=utf-8", page),
            "https://dawn.test/big.jpg": (200, "image/jpeg", photo(1600, 1000)),
        }
    )
    p, _ = _picker(settings, f)
    items = {1: _item(1, "https://dawn.test/news/1", urls=["https://img.test/thumb.jpg"])}
    (c,) = _pick(p, _story(1), items)
    assert c.cand.url == "https://dawn.test/big.jpg" and c.cand.alt == "Flooded street"
    assert c.image.width == 1600 and c.to_api().alt == "Flooded street"


def test_other_cited_items_then_posts_are_tried_and_uncited_items_never(settings):
    f = ImgFetcher({"https://pbs.twimg.com/media/p.jpg": (200, "image/jpeg", photo())})
    p, _ = _picker(settings, f)
    items = {
        1: _item(1, "https://a.test/1", fetched=True),  # page read at collection, no image
        2: _item(2, "https://news.google.com/rss/articles/xyz", kind="gnews"),  # undecoded: never fetched
        3: _item(3, "https://a.test/3", urls=["https://img.test/uncited.jpg"]),
    }
    posts = {7: PostRef(7, "https://x.com/a/status/7", "Hamid Mir", "https://pbs.twimg.com/media/p.jpg", "Alt by X")}
    (c,) = _pick(p, _story(1, 2, posts=[7]), items, posts)
    assert c.cand.post.db_id == 7 and c.cand.referer == "https://x.com/a/status/7"
    api = c.to_api()
    assert api.post_id == 7 and api.item_id is None and api.source_id is None and api.credit == "Hamid Mir"
    assert api.alt == "Alt by X"
    urls = [c["url"] for c in f.calls]
    assert not any("google" in u or "uncited" in u or "a.test" in u for u in urls)


def test_a_feeds_stock_picture_is_skipped(settings):
    f = ImgFetcher(
        {
            "https://img.test/stock.jpg": (200, "image/jpeg", photo(seed=2)),
            "https://img.test/real.jpg": (200, "image/jpeg", photo(seed=3)),
        }
    )
    items_in = [
        ItemIn(
            source_id=10,
            url=f"https://a.test/{n}",
            url_canonical=f"a.test/{n}",
            title="t",
            content_hash=str(n),
            image_url="https://img.test/stock.jpg",
        )
        for n in range(3)
    ]
    reused = reused_urls(items_in)
    assert reused == {(10, "https://img.test/stock.jpg")}
    p, _ = _picker(settings, f, reused=reused)
    items = {
        1: _item(1, "https://a.test/1", urls=["https://img.test/stock.jpg"], fetched=True),
        2: _item(2, "https://b.test/2", urls=["https://img.test/real.jpg"], source_id=11, fetched=True),
    }
    (c,) = _pick(p, _story(1, 2), items)
    assert c.cand.url == "https://img.test/real.jpg"
    assert "https://img.test/stock.jpg" not in [x["url"] for x in f.calls]


def test_the_same_picture_never_shows_twice_and_a_feeds_repeat_is_dropped(settings):
    same = photo(seed=5)
    f = ImgFetcher({f"https://img.test/{n}.jpg": (200, "image/jpeg", same) for n in range(4)})
    p, _ = _picker(settings, f)
    items = {n: _item(n, f"https://a.test/{n}", urls=[f"https://img.test/{n}.jpg"], fetched=True) for n in range(4)}
    items[3].source_id = 99
    two = asyncio.run(p.pick_all([("g", _story(0, order=0)), ("g", _story(3, order=1))], items, {}))
    assert [c.story.order for c in two] == [0]  # the second story would repeat the first's picture
    p2, _ = _picker(settings, f)
    three = asyncio.run(p2.pick_all([("g", _story(n, order=n)) for n in range(3)], items, {}))
    assert three == []  # one feed, one picture on three stories: its stock image


def test_vision_placeholder_moves_on_to_the_next_candidate(settings):
    f = ImgFetcher(
        {
            "https://img.test/card.jpg": (200, "image/jpeg", photo(seed=7)),
            "https://img.test/photo.jpg": (200, "image/jpeg", photo(seed=8)),
        }
    )
    answers = iter([{"graphic": False, "placeholder_or_logo": True}, {"graphic": True, "placeholder_or_logo": False}])
    llm = FakeLLM(responses={"image": lambda user: next(answers)})
    p, _ = _picker(settings, f, llm)
    items = {
        1: _item(1, "https://a.test/1", urls=["https://img.test/card.jpg"], fetched=True),
        2: _item(2, "https://a.test/2", urls=["https://img.test/photo.jpg"], fetched=True),
    }
    (c,) = _pick(p, _story(1, 2), items)
    assert c.cand.url == "https://img.test/photo.jpg" and c.graphic is True and c.checked
    # both outcomes are kept (the run posts them as stage "image" outputs): why the card was passed over
    assert [(v["source_url"], v["placeholder_or_logo"], v["graphic"], v["reason"]) for v in p.verdicts] == [
        ("https://img.test/card.jpg", True, False, "checked"),
        ("https://img.test/photo.jpg", False, True, "checked"),
    ]
    assert all(v["group"] == "pakistan" and v["order"] == 0 and len(v["sha256"]) == 64 for v in p.verdicts)
    assert [len(call["images"]) for call in llm.calls] == [1, 1]
    assert all(call["images"][0].media_type == "image/webp" for call in llm.calls)


def test_a_failed_vision_check_counts_as_graphic(settings):
    f = ImgFetcher({"https://img.test/a.jpg": (200, "image/jpeg", photo())})
    items = {1: _item(1, "https://a.test/1", urls=["https://img.test/a.jpg"], fetched=True)}
    llm = FakeLLM(responses={"image": LLMError("image:pakistan:0: error_max_budget_usd", cost_usd=0.003)})
    p, spent = _picker(settings, f, llm)
    (c,) = _pick(p, _story(1), items)
    assert c.graphic is True and c.checked is False and spent["failed"] == [0.003]
    (v,) = p.verdicts
    assert v["graphic"] and not v["checked"] and v["reason"].startswith("failed:") and v["cost_usd"] == 0.003

    class Boom:
        async def structured(self, **kw):
            raise RuntimeError("CLI crashed")

    p2, _ = _picker(settings, f, Boom())
    (c2,) = _pick(p2, _story(1), items)
    assert c2.graphic is True and not c2.checked


def test_a_vision_check_that_hangs_times_out_as_graphic(settings, monkeypatch):
    monkeypatch.setattr(picker_mod, "CHECK_TIMEOUT_S", 0.05)

    class Slow:
        async def structured(self, **kw):
            await asyncio.sleep(5)

    f = ImgFetcher({"https://img.test/a.jpg": (200, "image/jpeg", photo())})
    p, _ = _picker(settings, f, Slow())
    (c,) = _pick(p, _story(1), {1: _item(1, "https://a.test/1", urls=["https://img.test/a.jpg"], fetched=True)})
    assert c.graphic is True and not c.checked
    assert [v["reason"] for v in p.verdicts] == ["no answer in 0 s"]


def test_image_check_off_or_budget_spent_means_unchecked_graphic(settings):
    f = ImgFetcher({"https://img.test/a.jpg": (200, "image/jpeg", photo())})
    items = {1: _item(1, "https://a.test/1", urls=["https://img.test/a.jpg"], fetched=True)}
    llm = FakeLLM(responses={"image": {"graphic": False, "placeholder_or_logo": False}})
    settings.image_check = False
    (c,) = _pick(_picker(settings, f, llm)[0], _story(1), items)
    assert c.graphic is True and not c.checked
    settings.images_trust_unchecked = True
    (c,) = _pick(_picker(settings, f, llm)[0], _story(1), items)
    assert c.graphic is False and not c.checked
    settings.image_check, settings.images_trust_unchecked = True, False
    p, _ = _picker(settings, f, llm, budget_ok=lambda: False)
    (c,) = _pick(p, _story(1), items)
    assert c.graphic is True and not c.checked
    assert llm.calls == []  # never asked: check off, then the ceiling reached
    assert [(v["reason"], v["tokens_in"]) for v in p.verdicts] == [("daily usage ceiling reached", 0)]


@pytest.mark.parametrize(
    ("status", "ctype", "body"),
    [
        (200, "image/svg+xml", b"<svg/>"),
        (200, "text/html", b"<html></html>"),
        (200, "", photo()),
        (404, "text/plain", b""),
    ],
)
def test_downloads_need_an_image_content_type(settings, status, ctype, body):
    f = ImgFetcher({"https://img.test/a.jpg": (status, ctype, body)})
    p, _ = _picker(settings, f)
    with pytest.raises(ImageRejected):
        p.download(picker_mod.Candidate("https://img.test/a.jpg", "https://a.test/1", "direct", None))


def test_robots_txt_of_the_image_host_is_honoured(settings):
    f = ImgFetcher(
        {
            "https://img.test/robots.txt": (200, "text/plain", b"User-agent: *\nDisallow: /private/\n"),
            "https://img.test/private/a.jpg": (200, "image/jpeg", photo()),
        }
    )
    p, _ = _picker(settings, f)
    with pytest.raises(ImageRejected, match="robots"):
        p.download(picker_mod.Candidate("https://img.test/private/a.jpg", "https://a.test/1", "direct", None))
    assert "https://img.test/private/a.jpg" not in [c["url"] for c in f.calls]


def test_image_downloads_keep_the_hosts_crawl_delay(settings):
    """An image host's Crawl-delay spaces its images like its pages: a second request that would have
    to wait longer than the run allows is not sent."""
    f = ImgFetcher(
        {
            "https://img.test/robots.txt": (200, "text/plain", b"User-agent: *\nCrawl-delay: 120\n"),
            "https://img.test/a.jpg": (200, "image/jpeg", photo()),
            "https://img.test/b.jpg": (200, "image/jpeg", photo(seed=3)),
        }
    )
    p, _ = _picker(settings, f)
    assert p.download(picker_mod.Candidate("https://img.test/a.jpg", "https://a.test/1", "direct", None))
    with pytest.raises(ImageRejected, match="Crawl-delay"):
        p.download(picker_mod.Candidate("https://img.test/b.jpg", "https://a.test/2", "direct", None))
    assert [c["url"] for c in f.image_calls()] == ["https://img.test/a.jpg"]


def test_the_image_step_stops_starting_work_at_its_time_limit(settings):
    settings.image_time_limit_s = 0
    f = ImgFetcher({"https://img.test/lead.jpg": (200, "image/jpeg", photo())})
    llm = FakeLLM(responses={"image": {"graphic": False, "placeholder_or_logo": False}})
    p, _ = _picker(settings, f, llm)
    items = {1: _item(1, "https://dawn.test/news/1", urls=["https://img.test/lead.jpg"])}
    assert _pick(p, _story(1), items) == []
    assert f.image_calls() == [] and llm.calls == [] and p.stats["time limit"] == 1


def test_item_and_post_refs():
    src = Source(id=10, group_id=1, name="Google News: Pakistan", kind="gnews", url="https://news.google.com/rss")
    it = ItemIn(
        source_id=10,
        url="https://www.dawn.com/news/1",
        url_canonical="dawn.com/news/1",
        title="t",
        content_hash="h",
        image_url="https://lh3.googleusercontent.com/thumb",
        site_name="Dawn",
        raw={"article": {"image_url": "https://images.dawn.com/lead.jpg"}},
        fetch=ItemFetch(via="article"),
    )
    ref = item_ref(5, it, src, "direct")
    assert ref.image_urls == ["https://images.dawn.com/lead.jpg"] and ref.credit == "Dawn" and ref.page_fetched
    rss = Source(id=11, group_id=1, name="Dawn", url="https://dawn.test/feed")
    assert item_ref(6, it.model_copy(update={"raw": None, "fetch": None}), rss, "germany").image_urls == [
        "https://lh3.googleusercontent.com/thumb"
    ]
    post = PostRecord(
        id=9,
        author_handle="dawn_com",
        author_name="",
        text="x",
        url="https://x.com/dawn_com/status/9",
        posted_at="2026-09-23T07:30:00+00:00",
        media=[
            {"type": "video", "url": "https://video.twimg.com/v.mp4", "preview_url": "https://pbs.twimg.com/v.jpg"},
            {"type": "photo", "url": "https://pbs.twimg.com/media/p.jpg", "alt": "Alt text"},
            {"type": "bogus"},
        ],
    )
    assert post.media == [
        PostMedia(type="video", url="https://video.twimg.com/v.mp4", preview_url="https://pbs.twimg.com/v.jpg"),
        PostMedia(type="photo", url="https://pbs.twimg.com/media/p.jpg", alt="Alt text"),
    ]
    pr = post_ref(post)
    assert (pr.photo_url, pr.photo_alt, pr.credit) == ("https://pbs.twimg.com/media/p.jpg", "Alt text", "@dawn_com")


# ---- delivery -------------------------------------------------------------------------------------
@respx.mock
def test_upload_payload_and_the_story_gets_the_image_id(settings):
    f = ImgFetcher({"https://img.test/a.jpg": (200, "image/jpeg", photo(1600, 900))})
    p, _ = _picker(settings, f)
    st = _story(1)
    chosen = _pick(p, st, {1: _item(1, "https://a.test/1", urls=["https://img.test/a.jpg"], fetched=True)})
    route = respx.post(f"{BASE}/api/worker/images").mock(
        return_value=httpx.Response(201, json={"image_id": 71, "created": True})
    )
    api = WorkerApi(BASE, "tok", backoff=0)
    meta = p.deliver(chosen, api=api, out_dir=None)
    body = json.loads(route.calls[0].request.content)
    assert st.image_id == 71 and meta[0]["image_id"] == 71
    assert body["item_id"] == 1 and body["post_id"] is None and body["source_id"] == 10 and body["credit"] == "Dawn"
    assert body["source_url"] == "https://img.test/a.jpg" and body["graphic"] is False and body["alt"] is None
    assert (body["width"], body["height"]) == (1600, 900) and len(body["sha256"]) == 64
    for v in body["variants"]:
        data = base64.b64decode(v["data_base64"], validate=True)
        with Image.open(io.BytesIO(data)) as im:
            assert im.size == (v["w"], v["h"]) and v["mime"] == "image/webp"
        assert abs(v["h"] - v["w"] * 900 / 1600) <= 2 and len(data) <= 600 * 1024
    assert sum(len(v["data_base64"]) for v in body["variants"]) < 1_600_000


@respx.mock
def test_a_refused_upload_leaves_the_story_without_an_image(settings):
    f = ImgFetcher({"https://img.test/a.jpg": (200, "image/jpeg", photo())})
    p, _ = _picker(settings, f)
    st = _story(1)
    chosen = _pick(p, st, {1: _item(1, "https://a.test/1", urls=["https://img.test/a.jpg"], fetched=True)})
    respx.post(f"{BASE}/api/worker/images").mock(return_value=httpx.Response(413, json={"error": "too large"}))
    assert p.deliver(chosen, api=WorkerApi(BASE, "tok", backoff=0), out_dir=None) == []
    assert st.image_id is None


def test_dry_run_delivery_writes_files_and_uploads_nothing(settings, tmp_path):
    f = ImgFetcher({"https://img.test/a.jpg": (200, "image/jpeg", photo(700, 500))})
    p, _ = _picker(settings, f)
    st = _story(1)
    chosen = _pick(p, st, {1: _item(1, "https://a.test/1", urls=["https://img.test/a.jpg"], fetched=True)})
    (m,) = p.deliver(chosen, api=None, out_dir=tmp_path / "images")
    assert st.image_id is None and m["image_id"] is None
    assert sorted(x.split("-")[-1] for x in m["files"]) == ["480.webp", "700.webp"]
    assert all((tmp_path / "images" / f"{m['sha256']}-{w}.webp").is_file() for w in (480, 700))


# ---- the real Fetcher: size cap, SSRF on the image URL and on every redirect -------------------------------
def test_the_fetcher_stops_a_body_over_the_hard_limit(settings, servers, monkeypatch):  # noqa: F811
    site = servers("127.0.0.1", {"/big.jpg": (200, {"Content-Type": "image/jpeg"}, b"x" * 5000)})
    _pretend_public(monkeypatch, {"127.0.0.1"})
    f = http.Fetcher(settings)
    url = f"http://127.0.0.1:{site.port}/big.jpg"
    res = f.get(url, max_bytes=1000, hard_limit=True)
    assert res.too_large and not res.ok and res.content == b""
    cut = f.get(url, max_bytes=1000)  # feeds and pages keep the old behaviour: cut, not refused
    assert cut.ok and len(cut.content) == 1000


def test_image_urls_and_redirects_to_internal_addresses_are_never_fetched(settings, servers, monkeypatch):  # noqa: F811
    inside = servers("127.0.0.2", {"/secret.jpg": (200, {"Content-Type": "image/jpeg"}, photo())})
    outside = servers(
        "127.0.0.1",
        {
            "/robots.txt": (404, {}, b""),
            "/img.jpg": (302, {"Location": f"http://127.0.0.2:{inside.port}/secret.jpg"}, b""),
            "/meta.jpg": (307, {"Location": "http://169.254.169.254/latest/meta-data/"}, b""),
        },
    )
    fetcher = http.Fetcher(settings)
    p, _ = _picker(settings, fetcher)
    # the image URL itself points inside: nothing is sent to it, not even robots.txt
    with pytest.raises(ImageRejected):
        p.download(
            picker_mod.Candidate(f"http://127.0.0.2:{inside.port}/secret.jpg", "https://a.test/", "direct", None)
        )
    _pretend_public(monkeypatch, {"127.0.0.1"})
    for path in ("/img.jpg", "/meta.jpg"):
        with pytest.raises(ImageRejected, match="refused"):
            p.download(
                picker_mod.Candidate(f"http://127.0.0.1:{outside.port}{path}", "https://a.test/", "direct", None)
            )
    assert inside.seen == []
    assert [s for s in outside.seen if s != "/robots.txt"] == ["/img.jpg", "/meta.jpg"]
