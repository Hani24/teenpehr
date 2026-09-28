"""Research metadata (decision D5): feed, article and post metadata, the curation fields checked
against the cited items, Urdu entity names, and each Claude call's output kept on the server."""

import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
import respx

from conftest import NOW, fixture_text
from teenpehr.api import WorkerApi
from teenpehr.fetch.article import Article
from teenpehr.fetch.http import FetchResult
from teenpehr.fetch.rss import parse_feed
from teenpehr.models import (
    CurateOut,
    GlossaryEntry,
    Group,
    ItemIn,
    LlmStory,
    RunOutputIn,
    Source,
    StoryIn,
    UrduOut,
)
from teenpehr.normalize import detect_lang, word_count
from teenpehr.pipeline import (
    Collector,
    EditionRun,
    GroupWork,
    apply_article,
    apply_urdu,
    curation_to_stories,
    glossary_names,
    story_metadata,
)
from teenpehr.render import NumberedItem, render_stories_for_urdu
from teenpehr.social import bluesky, twitterapi_io
from teenpehr.social.x_list import parse_timeline_html, tweet_to_post
from test_pipeline import BASE, KHI, FakeFetcher, _fake_llm, _mock_api

RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Dawn - Pakistan</title><link>https://www.dawn.com</link>
<item><title>IMF approves tranche</title><link>https://www.dawn.com/news/1</link>
<guid isPermaLink="false">dawn-1</guid><dc:creator>Staff Reporter</dc:creator>
<category>Pakistan</category><category>Business</category><category>Pakistan</category>
<media:content url="https://i.dawn.com/1.jpg" medium="image" />
<description>&lt;p&gt;The IMF board approved the tranche in Washington.&lt;/p&gt;</description>
<pubDate>Wed, 23 Sep 2026 09:15:00 +0500</pubDate></item>
<item><title>Budget talks</title><link>https://www.dawn.com/news/2</link>
<enclosure url="https://i.dawn.com/2.png" type="image/png" length="1" />
<description>Short</description><pubDate>Wed, 23 Sep 2026 08:00:00 +0500</pubDate></item>
<item><title>Relative image</title><link>https://www.dawn.com/news/3</link>
<description>&lt;img src="/img/3.jpg"&gt; Floods in Sindh.</description></item>
</channel></rss>"""


# ---- feeds ----------------------------------------------------------------------------------------
def test_feed_entries_carry_their_metadata():
    a, b, c = parse_feed(RSS, "https://www.dawn.com/feeds/pakistan")
    assert a.author == "Staff Reporter" and a.categories == ["Pakistan", "Business"]  # de-duplicated
    assert a.image_url == "https://i.dawn.com/1.jpg" and a.guid == "dawn-1"
    assert a.description == "The IMF board approved the tranche in Washington."
    assert a.feed_title == "Dawn - Pakistan" and a.source_name is None
    assert a.updated is None  # an RSS pubDate is not an update time (feedparser would alias it)
    assert a.raw["tags"] == ["Pakistan", "Business"] and a.raw["id"] == "dawn-1"
    assert b.image_url == "https://i.dawn.com/2.png"  # an image enclosure
    assert c.image_url == "https://www.dawn.com/img/3.jpg"  # first <img>, made absolute


def test_atom_update_time_and_raw_cap():
    atom = parse_feed(fixture_text("atom.xml").encode())[0]
    assert atom.updated == datetime(2026, 9, 23, 3, 0, tzinfo=UTC) and atom.guid == "tag:amu,1"
    long = RSS.replace(b"IMF approves tranche", b"T" * 2000)
    assert len(parse_feed(long)[0].raw["title"]) == 500


def test_detect_lang_by_script():
    assert detect_lang("PM chairs meeting on IMF review") == "en"
    assert detect_lang("وزیراعظم کا اسلام آباد میں اہم اجلاس") == "ur"
    assert detect_lang("رئيس الوزراء يترأس اجتماعا") == "ar"
    assert detect_lang("طالبان فرمان جدید را اعلام کردند") == "fa"
    assert detect_lang("Le président a annoncé") == "und-Latn"
    assert detect_lang("प्रधानमंत्री ने बैठक की") == "hi"
    assert detect_lang("—") is None and word_count("one  two\nthree") == 3


class _Pages:
    def __init__(self, pages):
        self.pages = pages

    def get(self, url, *, route="direct", headers=None, conditional=False, allow_fallback=True, max_bytes=0, **kw):
        if url.endswith("/robots.txt"):
            return FetchResult(url=url, status=404, error="http 404", route_used=route)
        if url in self.pages:
            return FetchResult(url=url, status=200, content=self.pages[url], final_url=url, route_used=route, ms=7)
        return FetchResult(url=url, status=404, error="http 404", route_used=route, ms=3)

    def save_state(self):
        pass


ARTICLE = (
    '<html lang="en"><head><title>Budget talks</title><meta name="author" content="Ali Khan">'
    '<meta property="og:site_name" content="Dawn"><meta property="og:image" content="https://i.dawn.com/og.jpg">'
    '<meta name="description" content="Talks on the budget.">'
    '<meta property="article:published_time" content="2026-09-23T08:00:00+05:00">'
    '<meta property="article:tag" content="Budget"></head><body><article><h1>Budget talks</h1>'
    + "".join(
        f"<p>Paragraph {i}: the finance ministry and the IMF mission discussed the budget in Islamabad on "
        "Tuesday, officials said, and further talks are planned next week.</p>"
        for i in range(6)
    )
    + "</article></body></html>"
).encode()


def test_collector_sends_feed_metadata_and_fetch_info(settings):
    feed = "https://www.dawn.com/feeds/pakistan"
    f = _Pages({feed: RSS, "https://www.dawn.com/news/2": ARTICLE})
    c = Collector(settings, f, now=datetime(2026, 9, 23, tzinfo=UTC))
    src = Source(id=1, group_id=1, name="Dawn", kind="rss", url=feed)
    batch = c.fetch_source(src, datetime(2026, 9, 22, tzinfo=UTC))
    by = {it.title: it for it in batch.items}
    imf = by["IMF approves tranche"]
    assert imf.author == "Staff Reporter" and imf.categories == ["Pakistan", "Business"]
    assert imf.site_name == "Dawn - Pakistan" and imf.lang_detected == "en" and imf.word_count == 8
    assert imf.fetch.model_dump() == {"route": "direct", "tier": 1, "status": 200, "ms": 7, "via": "rss"}
    # a short blurb got the article page: its text, its fetch, and the page's metadata where the feed had none
    talks = by["Budget talks"]
    assert "finance ministry" in talks.text and talks.word_count > 100
    assert talks.fetch.via == "article" and talks.fetch.status == 200
    assert talks.author == "Ali Khan" and talks.site_name == "Dawn" and "Budget" in talks.categories
    assert talks.image_url == "https://i.dawn.com/2.png"  # the feed's own image stays
    assert talks.description == "Short" and talks.raw["article"]["date"] == "2026-09-23"


def test_apply_article_keeps_feed_text_when_the_page_has_less():
    it = ItemIn(
        source_id=1, url="https://a.test/1", url_canonical="a.test/1", title="T", text="x" * 50, content_hash="h" * 10
    )
    apply_article(it, Article(text="short", words=1, author="A", status=200, ms=5))
    assert it.text == "x" * 50 and it.fetch is None and it.author == "A" and it.raw == {"article": {"author": "A"}}
    apply_article(it, Article(status=0, author="B"))  # nothing fetched: nothing changes
    assert it.author == "A" and it.raw == {"article": {"author": "A"}}


# ---- posts ----------------------------------------------------------------------------------------
def test_x_posts_carry_counts_tags_links_media_and_thread():
    posts = parse_timeline_html(fixture_text("x_list_84839422.html"))
    video = next(p for p in posts if p.media and p.media[0].type == "video")
    assert video.media[0].url.endswith(".mp4") and video.media[0].preview_url.startswith("https://pbs.twimg.com/")
    first = posts[0]
    assert first.lang == "en" and first.metrics.likes == 3 and first.metrics.replies == 1
    assert first.metrics.views is None and first.conversation_id == first.platform_id
    assert any(p.hashtags for p in posts) and any(p.mentions for p in posts)

    tweet = {
        "id_str": "9",
        "user": {"screen_name": "a", "name": "A"},
        "created_at": "Wed Sep 23 14:17:38 +0000 2026",
        "full_text": "RT",
        "retweet_count": 0,
        "retweeted_status": {
            "id_str": "8",
            "user": {"screen_name": "b"},
            "full_text": "IMF #budget talks @dawn_com https://t.co/x",
            "lang": "en",
            "favorite_count": 40,
            "in_reply_to_status_id_str": "7",
            "conversation_id_str": "6",
            "entities": {
                "hashtags": [{"text": "budget"}],
                "user_mentions": [{"screen_name": "dawn_com"}],
                "urls": [{"url": "https://t.co/x", "expanded_url": "https://www.dawn.com/news/1"}],
            },
            "extended_entities": {
                "media": [
                    {"type": "photo", "media_url_https": "https://pbs.twimg.com/1.jpg", "ext_alt_text": "A chart"}
                ]
            },
        },
    }
    rt = tweet_to_post(tweet)
    assert rt.is_repost and rt.metrics.likes == 40  # a repost carries the original's content and counts
    assert rt.hashtags == ["budget"] and rt.mentions == ["dawn_com"] and rt.urls == ["https://www.dawn.com/news/1"]
    assert rt.media[0].alt == "A chart" and rt.in_reply_to == "7" and rt.conversation_id == "6"


def test_twitterapi_io_post_metadata():
    t = {
        "id": "5",
        "url": "https://x.com/a/status/5",
        "text": "Hello #IMF",
        "createdAt": "Wed Sep 23 14:17:38 +0000 2026",
        "lang": "en",
        "likeCount": 12,
        "retweetCount": 3,
        "replyCount": 1,
        "quoteCount": 0,
        "viewCount": 900,
        "inReplyToId": "4",
        "conversationId": "2",
        "author": {"userName": "a", "name": "A"},
        "entities": {"hashtags": [{"text": "IMF"}], "user_mentions": [{"screen_name": "b"}], "urls": []},
    }
    p = twitterapi_io._to_post(t, "a")
    assert p.metrics.model_dump() == {
        "replies": 1,
        "reposts": 3,
        "likes": 12,
        "quotes": 0,
        "views": 900,
        "bookmarks": None,
    }
    assert p.hashtags == ["IMF"] and p.mentions == ["b"] and p.in_reply_to == "4" and p.conversation_id == "2"


def test_bluesky_post_metadata():
    text = "Talks with @imf.bsky.social on #budget https://dawn.com/1"
    b = text.encode()
    at = b.index(b"@imf")
    item = {
        "post": {
            "uri": "at://did:plc:x/app.bsky.feed.post/3k",
            "cid": "c",
            "author": {"handle": "dawn.bsky.social", "displayName": "Dawn"},
            "record": {
                "text": text,
                "createdAt": "2026-09-23T03:00:00Z",
                "langs": ["en"],
                "reply": {"parent": {"uri": "at://p"}, "root": {"uri": "at://r"}},
                "facets": [
                    {
                        "index": {"byteStart": at, "byteEnd": at + 16},
                        "features": [{"$type": "app.bsky.richtext.facet#mention", "did": "did:plc:i"}],
                    },
                    {
                        "index": {"byteStart": 0, "byteEnd": 1},
                        "features": [{"$type": "app.bsky.richtext.facet#tag", "tag": "budget"}],
                    },
                    {
                        "index": {"byteStart": 0, "byteEnd": 1},
                        "features": [{"$type": "app.bsky.richtext.facet#link", "uri": "https://dawn.com/1"}],
                    },
                ],
            },
            "embed": {
                "$type": "app.bsky.embed.images#view",
                "images": [
                    {"fullsize": "https://cdn.bsky.app/f.jpg", "thumb": "https://cdn.bsky.app/t.jpg", "alt": ""}
                ],
            },
            "likeCount": 5,
            "repostCount": 2,
            "replyCount": 1,
            "quoteCount": 0,
        }
    }
    p = bluesky._to_post(item)
    assert p.lang == "en" and p.metrics.likes == 5 and p.hashtags == ["budget"] and p.mentions == ["imf.bsky.social"]
    assert p.urls == ["https://dawn.com/1"] and p.media[0].preview_url.endswith("t.jpg") and p.media[0].alt is None
    assert p.in_reply_to == "at://p" and p.conversation_id == "at://r"


def test_odd_metadata_shapes_keep_the_post():
    """Metadata is optional: a shape the extraction does not expect costs the metadata, not the post."""
    tweet = {
        "id_str": "9",
        "user": {"screen_name": "a", "name": "A"},
        "created_at": "Wed Sep 23 14:17:38 +0000 2026",
        "full_text": "Budget vote tonight",
        "favorite_count": 4,
        # a video variant with no url, and a hashtag entry that is not an object
        "extended_entities": {
            "media": [
                {
                    "type": "video",
                    "media_url_https": "https://pbs.twimg.com/v.jpg",
                    "video_info": {"variants": [{"content_type": "video/mp4", "bitrate": 1}]},
                }
            ]
        },
        "entities": {"hashtags": ["budget"]},
    }
    p = tweet_to_post(tweet)
    assert p is not None and p.text == "Budget vote tonight" and p.metrics is None and p.media is None
    item = {
        "post": {
            "uri": "at://did:plc:x/app.bsky.feed.post/3k",
            "author": {"handle": "dawn.bsky.social"},
            "record": {"text": "Hi", "createdAt": "2026-09-23T03:00:00Z", "facets": ["not a facet"]},
            "embed": {"$type": "app.bsky.embed.images#view", "images": [{"fullsize": 7}]},
        }
    }
    b = bluesky._to_post(item)
    assert b is not None and b.text == "Hi" and b.media is None
    t = {
        "id": "5",
        "text": "x",
        "author": {"userName": "a"},
        "extendedEntities": {"media": [{"media_url_https": 3}]},
        "entities": {"hashtags": [{"text": 5}]},
    }
    assert twitterapi_io._to_post(t, "a").text == "x"


# ---- curation metadata ----------------------------------------------------------------------------
def _gw() -> GroupWork:
    arts = [
        NumberedItem(
            idx=1,
            kind="article",
            db_id=101,
            title="IMF approves $1.1bn tranche for Pakistan",
            text="The International Monetary Fund's board met in Washington. Finance Minister Muhammad Aurangzeb welcomed it.",
        ),
        NumberedItem(idx=2, kind="article", db_id=102, title="Karachi rain", text="Heavy rain in Karachi."),
    ]
    posts = [
        NumberedItem(
            idx=3,
            kind="post",
            db_id=501,
            title="t",
            text="Good news for the economy",
            author_handle="HamidMirPAK",
            author_name="Hamid Mir",
        )
    ]
    return GroupWork(group=Group(id=1, slug="pakistan", name_en="Pakistan"), articles=arts, posts=posts)


def _story(**kw) -> dict:
    base = {
        "ref": 1,
        "refs": [1],
        "posts": [3],
        "title": "IMF approves loan tranche",
        "summary": "The IMF board approved it.",
    }
    return {**base, **kw}


def test_story_metadata_keeps_only_what_the_cited_items_say():
    st = LlmStory.model_validate(
        _story(
            keywords=["loan tranche", "IMF", "imf", "circular debt"],
            topics=["economy", "diplomacy", "economy", "made-up", "business", "politics"],
            countries=["pk", "US", "UK", "XX", "PAK"],
            places=["Washington", "Lahore"],
            event_type="agreement",
            entities=[
                {"name": "International Monetary Fund", "kind": "org", "role": "lender", "salience": 0.9},
                {"name": "Muhammad  Aurangzeb", "kind": "person", "role": "finance minister", "salience": 1.7},
                {"name": "Hamid Mir", "kind": "person", "salience": 0.2},
                {"name": "Shehbaz Sharif", "kind": "person", "role": "prime minister", "salience": 0.8},
                {"name": "Karachi", "kind": "place"},  # in another story's item, not this one's
                {"name": "IMF", "kind": "weird"},
            ],
        )
    )
    gw = _gw()
    [story] = curation_to_stories(CurateOut(lead="x", stories=[st]), gw, {}, "2026-09-23")
    assert story.topics == ["economy", "diplomacy", "business"]  # unknown dropped, de-duplicated, at most 3
    assert story.countries == ["PK", "US", "GB"] and story.places == ["Washington"]
    assert story.keywords == ["loan tranche", "IMF"]  # in the items or the story; one "IMF"
    assert story.event_type == "agreement"
    names = [(e.name_en, e.kind, e.salience) for e in story.entities]
    assert names == [
        ("Muhammad Aurangzeb", "person", 1.0),
        ("International Monetary Fund", "org", 0.9),
        ("IMF", "other", 0.5),
        ("Hamid Mir", "person", 0.2),  # a post's author is what the post cites
    ]
    _, dropped = story_metadata(st, "nothing here")
    assert "Shehbaz Sharif" in dropped and "Lahore" in dropped


def test_llm_story_drops_unknown_slugs_instead_of_failing():
    st = LlmStory.model_validate(
        _story(topics=["economy", 3, "nope"], event_type="coup", entities=[{"name": "X", "kind": "thing"}])
    )
    assert st.topics == ["economy"] and st.event_type is None and st.entities[0].kind == "other"
    schema = json.dumps(CurateOut.model_json_schema())
    assert '"courts-law"' in schema and '"economic-data"' in schema  # the model is offered the slugs


def test_urdu_entity_names_glossary_wins():
    gw = _gw()
    story = StoryIn(
        order=0,
        title_en="T",
        summary_en="S",
        sources=[{"item_id": 101}],
        entities=[
            {"name_en": "International Monetary Fund", "kind": "org"},
            {"name_en": "Muhammad Aurangzeb", "kind": "person"},
            {"name_en": "Hamid Mir", "kind": "person"},
        ],
    )
    gw.stories = [story]
    text = render_stories_for_urdu("lead", [story], {101: "Dawn"})
    assert "Entities: International Monetary Fund; Muhammad Aurangzeb; Hamid Mir" in text
    glossary = glossary_names(
        [
            GlossaryEntry(term_en="international monetary fund", term_ur="بین الاقوامی مالیاتی فنڈ", locked=False),
            GlossaryEntry(term_en="International Monetary Fund", term_ur="آئی ایم ایف", locked=True),
        ]
    )
    out = UrduOut.model_validate(
        {
            "lead_ur": "",
            "stories": [
                {
                    "idx": 1,
                    "title_ur": "عنوان",
                    "summary_ur": "خلاصہ",
                    "entities_ur": ["عالمی فنڈ", "محمد اورنگزیب", "Hamid Mir"],
                }
            ],
        }
    )
    apply_urdu(out, gw, "latn", glossary)
    assert [e.name_ur for e in story.entities] == ["آئی ایم ایف", "محمد اورنگزیب", ""]  # locked spelling; no Latin
    # a list that does not line up with the entities is not trusted
    story.entities[1].name_ur = ""
    out.stories[0].entities_ur = ["محمد اورنگزیب"]
    apply_urdu(out, gw, "latn", {})
    assert story.entities[1].name_ur == ""


# ---- the run ------------------------------------------------------------------------------------
def _meta_llm():
    llm = _fake_llm(with_bad_ref=False)
    curate = llm.responses["curate:pakistan"]
    curate["stories"][0].update(
        topics=["politics"],
        countries=["PK"],
        places=["Karachi"],
        event_type="statement",
        keywords=["rain"],
        entities=[
            {"name": "Hamid Mir", "kind": "person", "role": "journalist", "salience": 0.4},
            {"name": "Karachi", "kind": "place", "salience": 0.6},
            {"name": "Imran Khan", "kind": "person", "salience": 0.9},  # not in the story's items
        ],
    )
    llm.responses["urdu:pakistan"]["stories"][0]["entities_ur"] = ["کراچی", "حامد میر"]
    return llm


@respx.mock
def test_live_run_sends_metadata_and_keeps_outputs(settings):
    runs, fin, items, put, pub, glos = _mock_api()
    outputs = respx.post(f"{BASE}/api/worker/runs/42/outputs").mock(
        return_value=httpx.Response(201, json={"ids": [1, 2, 3, 4]})
    )
    report = EditionRun(
        settings, WorkerApi(BASE, "tok", backoff=0), _meta_llm(), FakeFetcher(), dry_run=False, now=NOW.astimezone(KHI)
    ).run()
    assert report.status == "ok"
    sent = json.loads(items.calls[0].request.content)["items"]
    geo = next(i for i in sent if i["url_canonical"] == "geo.tv/latest/1-rain")
    assert geo["fetch"] == {"route": "direct", "tier": 1, "status": 200, "ms": 12, "via": "rss"}
    assert geo["site_name"] == "Geo" and geo["description"] == "Heavy rain in Karachi." and "author" not in geo
    body = json.loads(put.calls[0].request.content)
    s1 = next(g for g in body["groups"] if g["group"] == "pakistan")["stories"][0]
    assert s1["topics"] == ["politics"] and s1["countries"] == ["PK"] and s1["event_type"] == "statement"
    assert [(e["name_en"], e["name_ur"]) for e in s1["entities"]] == [("Karachi", "کراچی"), ("Hamid Mir", "حامد میر")]
    kept = json.loads(outputs.calls[0].request.content)["outputs"]
    assert [(o["group"], o["stage"]) for o in kept] == [
        ("pakistan", "curate"),
        ("pakistan", "urdu"),
        ("pakistan", "qa"),
    ]
    assert kept[0]["output"]["stories"][0]["entities"][2]["name"] == "Imran Khan"  # the raw output, as Claude gave it
    assert kept[0]["model"] and kept[0]["tokens_in"] == 1000 and kept[0]["cost_usd"] == 0.01
    assert outputs.calls[0].request.url.path == "/api/worker/runs/42/outputs"


@respx.mock
def test_outputs_failure_does_not_fail_the_run(settings):
    _mock_api()
    respx.post(f"{BASE}/api/worker/runs/42/outputs").mock(return_value=httpx.Response(404, json={"error": "not found"}))
    report = EditionRun(
        settings, WorkerApi(BASE, "tok", backoff=0), _meta_llm(), FakeFetcher(), dry_run=False, now=NOW.astimezone(KHI)
    ).run()
    assert report.status == "ok" and report.publish_status == "published"


@respx.mock
def test_dry_run_file_holds_items_and_outputs(settings):
    _mock_api()
    report = EditionRun(
        settings, WorkerApi(BASE, "tok", backoff=0), _meta_llm(), FakeFetcher(), dry_run=True, now=NOW.astimezone(KHI)
    ).run()
    out = json.loads(Path(report.out_file).read_text(encoding="utf-8"))
    assert {i["url_canonical"] for i in out["items"]} >= {"geo.tv/latest/1-rain", "jang.com.pk/news/1"}
    assert all(i["fetch"]["via"] == "rss" and "lang_detected" in i for i in out["items"])
    assert [o["stage"] for o in out["outputs"]][:3] == ["curate", "urdu", "qa"]
    pk = next(g for g in out["edition"]["groups"] if g["group"] == "pakistan")
    assert pk["stories"][0]["entities"][0]["name_en"] == "Karachi"


@respx.mock
def test_post_run_outputs_is_never_replayed_after_a_read_timeout():
    route = respx.post(f"{BASE}/api/worker/runs/7/outputs").mock(side_effect=httpx.ReadTimeout("slow"))
    api = WorkerApi(BASE, "tok", backoff=0)
    out = RunOutputIn(stage="qa", output={"stories": []})
    with pytest.raises(httpx.ReadTimeout):
        api.post_run_outputs(7, [out])
    assert route.call_count == 1
    route.mock(return_value=httpx.Response(201, json={"ids": [5]}))
    assert api.post_run_outputs(7, [out] * 101) == [5, 5]  # chunks of 100
    assert json.loads(route.calls[-1].request.content)["outputs"][0] == {
        "group": None,
        "stage": "qa",
        "model": "",
        "tokens_in": 0,
        "tokens_out": 0,
        "cost_usd": 0.0,
        "output": {"stories": []},
    }
