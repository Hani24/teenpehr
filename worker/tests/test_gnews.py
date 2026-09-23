from conftest import fixture_bytes
from teenpehr.fetch import gnews, rss


def test_clean_title_strips_outlet():
    assert gnews.clean_title("PM chairs meeting on IMF review - Dawn") == "PM chairs meeting on IMF review"


def test_legacy_link_decodes_without_network(monkeypatch):
    monkeypatch.setattr(gnews, "_decode_batchexecute", lambda url: None)
    entries = rss.parse_feed(fixture_bytes("rss_gnews.xml"))
    assert gnews.decode_link(entries[0].link) == "https://www.dawn.com/news/1934567"


def test_undecodable_link_uses_follower_then_falls_back(monkeypatch):
    monkeypatch.setattr(gnews, "_decode_batchexecute", lambda url: None)
    entries = rss.parse_feed(fixture_bytes("rss_gnews.xml"))
    bad = entries[1].link
    assert (
        gnews.decode_link(bad, follow=lambda u: "https://www.reuters.com/world/x") == "https://www.reuters.com/world/x"
    )
    assert gnews.decode_link(bad, follow=lambda u: "https://news.google.com/still") == bad
    assert gnews.decode_link(bad) == bad


def test_non_gnews_link_passthrough():
    assert gnews.decode_link("https://www.dawn.com/news/1") == "https://www.dawn.com/news/1"
