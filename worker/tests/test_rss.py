from datetime import UTC, datetime

from conftest import fixture_bytes
from teenpehr.fetch import rss, youtube


def test_utf8_body_without_declaration_keeps_urdu():
    entries = rss.parse_feed(fixture_bytes("rss_urdu_nodecl.xml"))
    assert len(entries) == 2
    assert entries[0].title == "وزیراعظم کا اسلام آباد میں اہم اجلاس"
    assert "شہباز شریف" in entries[0].summary and "<p>" not in entries[0].summary
    assert entries[0].published == datetime(2026, 9, 23, 3, 0, tzinfo=UTC)


def test_lying_iso_8859_1_declaration_is_ignored():
    entries = rss.parse_feed(fixture_bytes("rss_geo_lying_decl.xml"))
    assert entries[0].title == "Geo: کراچی میں بارش"
    assert entries[0].link.startswith("https://www.geo.tv/latest/1-rain")


def test_atom_content_and_links():
    entries = rss.parse_feed(fixture_bytes("atom.xml"))
    assert [e.link for e in entries] == ["https://amu.tv/1", "https://amu.tv/2"]
    assert entries[0].summary == "The decree was announced on Tuesday."
    assert entries[0].published == datetime(2026, 9, 23, 3, 0, tzinfo=UTC)
    assert entries[1].summary == "Summary two"


def test_two_digit_year_dates_parse():
    entries = rss.parse_feed(fixture_bytes("rss_express_2digit_year.xml"))
    assert entries[0].published is not None and entries[0].published.year == 2026


def test_youtube_channel_feed():
    entries = youtube.parse_channel_feed(fixture_bytes("youtube.xml"))
    assert len(entries) == 1
    assert entries[0].link == "https://www.youtube.com/watch?v=abc"
    assert entries[0].title == "Headlines 9pm"


def test_strip_html_and_bad_input():
    assert rss.strip_html("<b>Hi</b>&amp; there  ") == "Hi & there"
    assert rss.parse_feed(b"not xml at all") == []
