"""The full-text fetch behind a reader's Urdu translation request (D9): robots.txt for our token and for
Claude-User, redirects checked hop by hop, paywalls and AI opt-outs respected, hosts blocked from
Pakistan marked needs_germany when the Germany route is down, temporary trouble retried later. No
network: a fake Fetcher answers from a table."""

from __future__ import annotations

import json

import pytest

from teenpehr.fetch.http import FetchResult
from teenpehr.jobs.fulltext import (
    FullTextFetcher,
    TryLater,
    Unavailable,
    clean_paragraphs,
    is_wall_path,
    page_signals,
)
from teenpehr.translate import chunk_paragraphs, figures, missing_figures

WORDS = "The minister said on Tuesday that the plan would go ahead as agreed with the provinces"


def article(paragraphs: int = 6, extra_head: str = "", title: str = "Plan goes ahead") -> bytes:
    body = "\n".join(
        f"<p>{WORDS}, paragraph {i} of the report, with 2,500 people affected.</p>" for i in range(1, paragraphs + 1)
    )
    return (
        f"<html><head><title>{title}</title>{extra_head}</head><body><nav>Home</nav>"
        f"<article><h1>{title}</h1>{body}</article><footer>Copyright</footer></body></html>"
    ).encode()


def ok(url: str, content: bytes, ctype: str = "text/html; charset=utf-8", headers: dict | None = None) -> FetchResult:
    return FetchResult(
        url=url, status=200, content=content, headers={"content-type": ctype, **(headers or {})}, final_url=url
    )


def status(url: str, code: int, **kw) -> FetchResult:
    return FetchResult(url=url, status=code, error=f"http {code}", **kw)


class TableFetcher:
    """Answers GETs from `table` (url -> FetchResult or callable(route) -> FetchResult); a robots.txt not in
    the table is a 404 (no rules). Records (url, route, follow_redirects)."""

    def __init__(self, table: dict):
        self.table = table
        self.calls: list[tuple[str, str, bool]] = []

    def cooldown_left(self, url: str) -> float:
        return 0.0

    def get(self, url, *, route="direct", headers=None, allow_fallback=True, max_bytes=0, follow_redirects=True, **kw):
        self.calls.append((url, route, follow_redirects))
        hit = self.table.get((url, route)) or self.table.get(url)
        if callable(hit):
            hit = hit(route)
        if hit is None:
            if url.endswith("/robots.txt"):
                return status(url, 404)
            return status(url, 404)
        return hit


def make(settings, table, *, germany=False, clock=None):
    slept: list[float] = []
    t = [1000.0]
    f = TableFetcher(table)
    ft = FullTextFetcher(
        f,
        settings,
        clock=clock or (lambda: t[0]),
        sleep=lambda s: slept.append(s),
        germany_check=lambda: germany,
    )
    return ft, f, slept


URL = "https://news.test/2026/09/plan"


def test_a_plain_article_comes_back_as_paragraphs(settings):
    ft, f, _ = make(settings, {URL: ok(URL, article(6))})
    full = ft.fetch(URL, title_hint="Plan goes ahead")
    assert full.title == "Plan goes ahead"
    assert len(full.paragraphs) == 6 and full.paragraphs[0].startswith("The minister said")
    assert full.lang == "en" and full.words > 60 and len(full.text_hash) == 64
    # robots.txt first, then the page with redirects handled here, on the source's route
    assert f.calls[0] == ("https://news.test/robots.txt", "direct", True)
    assert f.calls[1] == (URL, "direct", False)


@pytest.mark.parametrize(
    ("robots", "who"),
    [
        ("User-agent: *\nDisallow: /2026/", "this page"),
        ("User-agent: Claude-User\nDisallow: /\n\nUser-agent: *\nAllow: /", "Claude-User"),
        ("User-agent: teenpehr\nDisallow: /2026/09/", "this page"),
    ],
)
def test_robots_txt_for_our_token_or_claude_user_is_honoured(settings, robots, who):
    ft, f, _ = make(
        settings,
        {
            "https://news.test/robots.txt": ok("https://news.test/robots.txt", robots.encode(), "text/plain"),
            URL: ok(URL, article()),
        },
    )
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "robots_disallowed" and who in e.value.note
    assert all(c[0] != URL for c in f.calls)  # the page itself was never requested


def test_crawl_delay_spaces_requests_to_one_host(settings):
    robots = ok("https://news.test/robots.txt", b"User-agent: *\nCrawl-delay: 5", "text/plain")
    ft, f, slept = make(settings, {"https://news.test/robots.txt": robots, URL: ok(URL, article())})
    ft.fetch(URL)
    assert slept and 4.9 <= slept[0] <= 5.0  # robots.txt and the page were 5 s apart


def test_a_crawl_delay_too_long_to_wait_is_tried_later(settings):
    robots = ok("https://news.test/robots.txt", b"User-agent: *\nCrawl-delay: 600", "text/plain")
    ft, _, _ = make(settings, {"https://news.test/robots.txt": robots, URL: ok(URL, article())})
    with pytest.raises(TryLater) as e:
        ft.fetch(URL)
    assert e.value.retry_after_s and e.value.retry_after_s >= 599


@pytest.mark.parametrize(
    ("head", "why"),
    [
        (
            '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>',
            "isAccessibleForFree",
        ),
        (
            '<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","isAccessibleForFree":"False"}]}</script>',
            "isAccessibleForFree",
        ),
        ('<meta property="article:content_tier" content="locked">', "locked"),
        ('<meta property="article:content_tier" content="metered">', "metered"),
    ],
)
def test_a_page_its_publisher_marks_as_not_free_is_never_taken_even_with_text(settings, head, why):
    ft, _, _ = make(settings, {URL: ok(URL, article(10, head))})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "paywalled" and why in e.value.note


@pytest.mark.parametrize("code", [401, 402])
def test_401_and_402_are_paywalls(settings, code):
    ft, _, _ = make(settings, {URL: status(URL, code)})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "paywalled"


def test_a_short_teaser_beside_subscription_prompts_is_a_paywall_and_without_them_no_text(settings):
    teaser = b"<html><body><article><p>Only the first lines of the story are free to read here today.</p></article><div class='paywall'>Subscribe to continue reading</div></body></html>"
    ft, _, _ = make(settings, {URL: ok(URL, teaser)})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "paywalled"
    plain = (
        b"<html><body><article><p>Watch the video of the minister's speech in the capital.</p></article></body></html>"
    )
    ft, _, _ = make(settings, {URL: ok(URL, plain)})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "no_text"


def test_ai_opt_outs_are_respected(settings):
    ft, _, _ = make(
        settings, {URL: ok(URL, article(6, '<meta name="robots" content="index, follow, noai, noimageai">'))}
    )
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "robots_disallowed" and "noai" in e.value.note
    ft, _, _ = make(settings, {URL: ok(URL, article(6), headers={"x-robots-tag": "noai"})})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "robots_disallowed"


def test_redirects_are_followed_hop_by_hop_with_each_hosts_robots_txt(settings):
    other = "https://cdn.other.test/story/plan"
    table = {
        URL: FetchResult(url=URL, status=301, error="http 301", headers={"location": other}),
        other: ok(other, article(6)),
    }
    ft, f, _ = make(settings, table)
    full = ft.fetch(URL)
    assert full.final_url == other
    assert [c[0] for c in f.calls] == ["https://news.test/robots.txt", URL, "https://cdn.other.test/robots.txt", other]
    table["https://cdn.other.test/robots.txt"] = ok("x", b"User-agent: *\nDisallow: /story/", "text/plain")
    ft, f, _ = make(settings, table)
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "robots_disallowed" and other not in [c[0] for c in f.calls]


def test_a_redirect_to_a_sign_in_or_subscribe_page_is_a_paywall(settings):
    table = {
        URL: FetchResult(
            url=URL, status=302, error="http 302", headers={"location": "/account/login?next=/2026/09/plan"}
        )
    }
    ft, _, _ = make(settings, table)
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "paywalled"
    assert (
        is_wall_path("/subscribe.html") and is_wall_path("/login") and not is_wall_path("/news/register-voters-drive")
    )


def test_a_host_blocked_from_pakistan_with_the_germany_route_down_needs_germany(settings):
    blocked = FetchResult(url="x", status=0, error="CouldNotResolve", blocked=True)
    ft, f, _ = make(settings, {"https://news.test/robots.txt": blocked}, germany=False)
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "needs_germany"
    assert all(route == "direct" for _, route, _ in f.calls)  # nothing was tried through a dead tunnel


def test_a_germany_source_with_the_route_down_needs_germany_without_any_request(settings):
    ft, f, _ = make(settings, {}, germany=False)
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL, route="germany")
    assert e.value.reason == "needs_germany" and f.calls == []


def test_with_the_germany_route_up_a_blocked_host_is_read_through_it(settings):
    blocked = FetchResult(url="x", status=0, error="connection reset", blocked=True)
    table = {
        ("https://news.test/robots.txt", "direct"): blocked,
        ("https://news.test/robots.txt", "germany"): status("x", 404),
        (URL, "germany"): ok(URL, article(6)),
    }
    ft, f, _ = make(settings, table, germany=True)
    full = ft.fetch(URL)
    assert full.route == "germany" and f.calls[-1] == (URL, "germany", False)


def test_temporary_trouble_is_tried_later_and_final_on_the_last_attempt(settings):
    ft, _, _ = make(settings, {URL: status(URL, 503)})
    with pytest.raises(TryLater):
        ft.fetch(URL)
    ft, _, _ = make(settings, {URL: status(URL, 503)})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL, last_attempt=True)
    assert e.value.reason == "unreachable"
    limited = FetchResult(url=URL, status=429, error="http 429", rate_limited=True, retry_after_s=120)
    ft, _, _ = make(settings, {URL: limited})
    with pytest.raises(TryLater) as t:
        ft.fetch(URL, last_attempt=True)  # a 429 is always "later", never a reason to push
    assert t.value.retry_after_s == 120


def test_robots_txt_that_cannot_be_read_blocks_the_page_for_now(settings):
    ft, f, _ = make(settings, {"https://news.test/robots.txt": status("x", 500), URL: ok(URL, article())})
    with pytest.raises(TryLater):
        ft.fetch(URL)
    assert [c[0] for c in f.calls] == ["https://news.test/robots.txt"]


@pytest.mark.parametrize(("code", "reason"), [(403, "unreachable"), (404, "unreachable"), (410, "unreachable")])
def test_refusals_and_missing_pages_are_final(settings, code, reason):
    ft, f, _ = make(settings, {URL: status(URL, code)})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == reason
    assert sum(1 for c in f.calls if c[0] == URL) == 1  # never a second try another way


def test_not_an_article_urdu_or_too_long(settings):
    ft, _, _ = make(settings, {URL: ok(URL, b"%PDF-1.7", "application/pdf")})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "not_article"
    urdu = (
        "<html><body><article>"
        + "".join(
            f"<p>{'وزیراعظم نے کہا کہ حکومت عوام کے لیے اقدامات کرے گی اور مہنگائی کم ہوگی ' * 3}</p>" for _ in range(5)
        )
        + "</article></body></html>"
    )
    ft, _, _ = make(settings, {URL: ok(URL, urdu.encode())})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "not_article" and "Urdu" in e.value.note
    settings.translate_max_words = 50
    ft, _, _ = make(settings, {URL: ok(URL, article(6))})
    with pytest.raises(Unavailable) as e:
        ft.fetch(URL)
    assert e.value.reason == "too_long"


def test_not_a_web_link(settings):
    ft, _, _ = make(settings, {})
    with pytest.raises(Unavailable) as e:
        ft.fetch("ftp://news.test/file")
    assert e.value.reason == "not_article"


# ---- helpers ------------------------------------------------------------------------------------
def test_clean_paragraphs_drops_furniture_and_the_repeated_headline_and_splits_long_blocks():
    text = "Plan goes ahead\nFirst paragraph.\nAdvertisement\n\nSecond one.\nRead more\n" + " ".join(
        ["A sentence here."] * 200
    )
    out = clean_paragraphs(text, "Plan goes ahead")
    assert out[:2] == ["First paragraph.", "Second one."]
    assert len(out) > 3 and all(len(p.split()) <= 300 for p in out)


def test_page_signals_read_jsonld_deeply_and_ignore_bad_blocks():
    page = (
        '<html><head><script type="application/ld+json">{not json</script>'
        '<script type="application/ld+json">'
        + json.dumps([{"@type": "WebPage", "hasPart": {"isAccessibleForFree": "false"}}])
        + "</script>"
        "</head><body></body></html>"
    )
    assert page_signals(page).paywall
    assert page_signals("<html><head><meta property='og:title' content='T'></head></html>").paywall is None


def test_figures_compare_digits_across_scripts_and_separators():
    assert figures("2,500 people, 3.5 percent, 1,000,000") == figures("2500 افراد، 3.5 فیصد، 1000000")
    assert figures("۲۰۲۶ میں ٢٥") == figures("2026 25")
    assert missing_figures("the 21st century began in 2001", "اکیسویں صدی 2001 میں شروع ہوئی") == []
    assert missing_figures("killed 12 people and hurt 40", "12 افراد ہلاک") == ["40"]


def test_chunks_group_paragraphs_by_words():
    paras = ["word " * 400, "word " * 400, "word " * 400, "word " * 50]
    assert chunk_paragraphs(paras, 900) == [[1, 2], [3, 4]]
    assert chunk_paragraphs(["word " * 1000], 900) == [[1]]


def test_the_same_article_extracted_twice_keeps_every_paragraph(settings):
    """trafilatura's deduplication remembers text process-wide; a retry must not lose paragraphs."""
    ft, _, _ = make(settings, {URL: ok(URL, article(6))})
    first = ft.fetch(URL)
    ft, _, _ = make(settings, {URL: ok(URL, article(6))})
    assert ft.fetch(URL).paragraphs == first.paragraphs and len(first.paragraphs) == 6


def test_publication_dates_and_the_related_links_they_date_are_furniture():
    text = (
        "- Published\nChina released more details on Monday.\n- Huge data centres rise at 'China speed'\n"
        "- Published6 days ago\n- Trump and Xi come face-to-face\n- Published5 days ago\nTrade truce - what was included\n"
        "- A real list item of the article\n- Another real item\nUpdated: 3 hours ago\nLast line.\n- Published25 August 2025"
    )
    assert clean_paragraphs(text) == [
        "China released more details on Monday.",
        "Trade truce - what was included",
        "- A real list item of the article",
        "- Another real item",
        "Last line.",
    ]


def test_only_date_lines_are_dropped_never_sentences_that_start_like_one():
    text = (
        "Updated guidance was issued on Monday.\nPublished figures show a 12% rise.\n"
        "Published in 2019, the report found.\nLast updated on September 29, 2026 at 10:30 am PKT\n"
        "Posted 2026-09-29T04:00:00Z\nUpdated 3 hours ago the minister said the talks would go on."
    )
    assert clean_paragraphs(text) == [
        "Updated guidance was issued on Monday.",
        "Published figures show a 12% rise.",
        "Published in 2019, the report found.",
        "Updated 3 hours ago the minister said the talks would go on.",
    ]


def test_a_crawl_delay_set_for_claude_user_is_kept_too(settings):
    text = b"User-agent: Claude-User\nCrawl-delay: 8\n\nUser-agent: *\nCrawl-delay: 2"
    robots = ok("https://news.test/robots.txt", text, "text/plain")
    ft, _, slept = make(settings, {"https://news.test/robots.txt": robots, URL: ok(URL, article())})
    ft.fetch(URL)
    assert slept and 7.9 <= slept[0] <= 8.0
