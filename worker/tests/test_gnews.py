import base64
import json
import threading
from urllib.parse import unquote

import googlenewsdecoder
import pytest
from googlenewsdecoder import _parse

from conftest import fixture_bytes
from teenpehr.fetch import gnews, rss
from teenpehr.fetch.http import FetchResult, host_lock

# A current-style id: base64 of a protobuf around an opaque token, with no URL in clear.
MODERN_ID = base64.urlsafe_b64encode(b"\x08\x13\x22\x58AU_yqLN" + b"q" * 80).decode().rstrip("=")
MODERN = f"https://news.google.com/rss/articles/{MODERN_ID}?oc=5"
MODERN_2 = MODERN.replace("CBMi", "CBMj", 1)
PUBLISHER = "https://indianexpress.com/article/india/monsoon-session-9912345/"
PUBLISHER_2 = "https://www.aljazeera.com/news/2026/9/23/gaza-talks"


@pytest.fixture(autouse=True)
def _no_pacing(monkeypatch):
    monkeypatch.setattr(gnews, "DECODE_SPACING_S", 0.0)
    monkeypatch.setattr(gnews, "_library_misses", 0)


@pytest.fixture
def no_library_client(monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("googlenewsdecoder's own HTTP client must not be used")

    monkeypatch.setattr(googlenewsdecoder, "gnewsdecoder", boom)


def _page(sig: str = "SIG1", ts: str = "1758614400") -> bytes:
    return (
        f'<html><body><c-wiz><div jscontroller="aLI87" data-n-a-sg="{sig}" data-n-a-ts="{ts}">'
        "</div></c-wiz></body></html>"
    ).encode()


def _batch_answer(pairs: list[tuple[str, str]]) -> bytes:
    """batchexecute's real envelope: an XSSI prefix, a blank line, then rows keyed by request id."""
    rows = [["wrb.fr", "Fbv4je", json.dumps(["garturlres", url, 1]), None, None, None, rid] for rid, url in pairs]
    rows += [["di", 42], ["af.httprm", 41, "-5155437442385823360", 12]]
    return (")]}'\n\n" + json.dumps(rows)).encode()


class GoogleFetcher:
    """Plays news.google.com: article pages by id (or a 302 to `redirect`), Google's block page,
    and one batchexecute answer."""

    def __init__(self, pages: dict[str, bytes], answer: bytes = b"", redirect: str | None = None, limit_at=None):
        self.pages, self.answer, self.redirect, self.limit_at = pages, answer, redirect, limit_at
        self.gets: list[str] = []
        self.posts: list[tuple[str, str, dict]] = []
        self.cooled: list[str] = []

    def cooldown_left(self, url):
        return 900.0 if self.cooled else 0.0

    def cool_down(self, url, retry_after=None):
        self.cooled.append(url)

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
    ):
        assert follow_redirects is False, "the decoder must not follow redirects blindly"
        self.gets.append(url)
        if self.limit_at is not None and len(self.gets) > self.limit_at:
            return FetchResult(url=url, status=429, error="http 429", rate_limited=True)
        if url.startswith("https://www.google.com/sorry"):
            return FetchResult(url=url, status=200, content=b"<html>unusual traffic</html>", final_url=url)
        if self.redirect:
            return FetchResult(url=url, status=302, headers={"location": self.redirect}, error="http 302")
        art = url.split("/articles/")[1].split("?")[0]
        if art not in self.pages:
            return FetchResult(url=url, status=404, error="http 404")
        return FetchResult(url=url, status=200, content=self.pages[art], final_url=url)

    def post(self, url, *, data, route="direct", headers=None, max_bytes=0):
        self.posts.append((url, data, headers or {}))
        return FetchResult(url=url, status=200, content=self.answer, final_url=url)


def test_clean_title_strips_outlet():
    assert gnews.clean_title("PM chairs meeting on IMF review - Dawn") == "PM chairs meeting on IMF review"


def test_legacy_link_decodes_without_network(no_library_client):
    entries = rss.parse_feed(fixture_bytes("rss_gnews.xml"))
    assert gnews.decode_link(entries[0].link) == "https://www.dawn.com/news/1934567"
    f = GoogleFetcher({})
    assert gnews.decode_link(entries[0].link, fetcher=f) == "https://www.dawn.com/news/1934567"
    assert f.gets == [] and f.posts == []


def test_modern_id_is_not_mistaken_for_legacy():
    assert gnews._decode_legacy(MODERN_ID) is None


def test_library_success_shape_is_read(monkeypatch):
    """googlenewsdecoder 0.2.x answers {"success": True, "decoded_url": ...} (its _parse.ok)."""
    calls = []

    def stub(url, *a, **kw):
        calls.append(url)
        assert host_lock("news.google.com").locked(), "decodes must hold the news.google.com host lock"
        return _parse.ok(decoded_url=PUBLISHER)

    monkeypatch.setattr(googlenewsdecoder, "gnewsdecoder", stub)
    assert gnews.decode_link(MODERN) == PUBLISHER
    assert calls == [MODERN]


def test_library_failure_shape_falls_back_to_follower(monkeypatch):
    monkeypatch.setattr(googlenewsdecoder, "gnewsdecoder", lambda url, *a, **kw: _parse.err("Failed to fetch data"))
    entries = rss.parse_feed(fixture_bytes("rss_gnews.xml"))
    bad = entries[1].link
    assert (
        gnews.decode_link(bad, follow=lambda u: "https://www.reuters.com/world/x") == "https://www.reuters.com/world/x"
    )
    assert gnews.decode_link(bad, follow=lambda u: "https://news.google.com/still") == bad
    # Google's block page is not a publisher either
    assert gnews.decode_link(bad, follow=lambda u: "https://www.google.com/sorry/index?continue=x") == bad
    assert gnews.decode_link(bad) == bad


def test_library_client_gives_up_after_repeated_refusals(monkeypatch):
    calls = []

    def refused(url, *a, **kw):
        calls.append(url)
        return _parse.err("Request error fetching params: 429 Too Many Requests")

    monkeypatch.setattr(googlenewsdecoder, "gnewsdecoder", refused)
    for _ in range(5):
        assert gnews.decode_link(MODERN) == MODERN
    assert len(calls) == 3


def test_library_answer_pointing_back_at_google_is_rejected(monkeypatch):
    monkeypatch.setattr(
        googlenewsdecoder, "gnewsdecoder", lambda url, *a, **kw: _parse.ok(decoded_url="https://consent.google.com/x")
    )
    assert gnews.decode_link(MODERN) == MODERN


def test_fetcher_path_decodes_a_batch_with_one_post(no_library_client):
    id2 = MODERN_2.split("/articles/")[1].split("?")[0]
    f = GoogleFetcher(
        {MODERN_ID: _page("SIG1", "111"), id2: _page("SIG2", "222")},
        answer=_batch_answer([("0", PUBLISHER), ("1", PUBLISHER_2)]),
    )
    out = gnews.decode_links([MODERN, MODERN_2, MODERN], fetcher=f)
    assert out == {MODERN: PUBLISHER, MODERN_2: PUBLISHER_2}
    assert len(f.gets) == 2 and all("/rss/articles/" in u and "hl=" in u for u in f.gets)
    [(url, body, headers)] = f.posts
    assert url == _parse.BATCHEXECUTE_URL
    assert headers["Content-Type"].startswith("application/x-www-form-urlencoded")
    sent = unquote(body)
    assert "SIG1" in sent and "SIG2" in sent and MODERN_ID in sent


def test_decode_link_with_fetcher(no_library_client):
    f = GoogleFetcher({MODERN_ID: _page()}, answer=_batch_answer([("0", PUBLISHER)]))
    assert gnews.decode_link(MODERN, fetcher=f) == PUBLISHER


def test_google_redirecting_to_the_publisher_needs_no_post(no_library_client):
    f = GoogleFetcher({}, redirect=PUBLISHER)
    assert gnews.decode_link(MODERN, fetcher=f) == PUBLISHER
    assert len(f.gets) == 1 and f.posts == []  # the publisher's page itself is not fetched here


def test_google_block_page_stops_the_batch_and_cools_the_host_down(no_library_client):
    id2 = MODERN_2.split("/articles/")[1].split("?")[0]
    f = GoogleFetcher({MODERN_ID: _page(), id2: _page()}, redirect="https://www.google.com/sorry/index?continue=x")
    assert gnews.decode_links([MODERN, MODERN_2], fetcher=f) == {}
    # the block page is neither a publisher nor fetched, and the second link is not asked about
    assert len(f.gets) == 1 and "news.google.com" in f.gets[0] and f.posts == []
    assert f.cooled == [MODERN]
    # the next source's batch sees the cooldown and makes no request (and does not sleep for pacing)
    assert gnews.decode_links([MODERN_2], fetcher=f) == {} and len(f.gets) == 1


def test_consent_wall_stops_the_batch_without_a_cooldown(no_library_client):
    id2 = MODERN_2.split("/articles/")[1].split("?")[0]
    f = GoogleFetcher({MODERN_ID: _page(), id2: _page()}, redirect="https://consent.google.com/ml?continue=x")
    assert gnews.decode_links([MODERN, MODERN_2], fetcher=f) == {}
    assert len(f.gets) == 1 and f.cooled == []


def test_library_client_is_not_called_by_threads_queued_after_it_gave_up(monkeypatch):
    calls = []

    def refused(url, *a, **kw):
        calls.append(url)
        return _parse.err("Request error fetching params: 429 Too Many Requests")

    monkeypatch.setattr(googlenewsdecoder, "gnewsdecoder", refused)
    monkeypatch.setattr(gnews, "_library_misses", gnews._LIBRARY_MAX_MISSES - 1)
    passed_first_check = threading.Event()
    monkeypatch.setattr(gnews, "_pace", passed_first_check.set)  # runs between the two checks
    lock = host_lock("news.google.com")
    with lock:  # another thread is decoding; it gives up while this one waits for the lock
        waiting = threading.Thread(target=gnews.decode_link, args=(MODERN,))
        waiting.start()
        assert passed_first_check.wait(5)
        monkeypatch.setattr(gnews, "_library_misses", gnews._LIBRARY_MAX_MISSES)
    waiting.join(5)
    assert not waiting.is_alive() and calls == []


def test_batch_answer_without_our_id_leaves_link(no_library_client):
    f = GoogleFetcher({MODERN_ID: _page()}, answer=_batch_answer([("7", PUBLISHER)]))
    assert gnews.decode_link(MODERN, fetcher=f) == MODERN


def test_rate_limit_stops_the_batch(no_library_client):
    id2 = MODERN_2.split("/articles/")[1].split("?")[0]
    f = GoogleFetcher({MODERN_ID: _page(), id2: _page()}, limit_at=0)
    assert gnews.decode_links([MODERN, MODERN_2], fetcher=f) == {}
    assert len(f.gets) == 1 and f.posts == []


def test_non_gnews_link_passthrough():
    assert gnews.decode_link("https://www.dawn.com/news/1") == "https://www.dawn.com/news/1"
