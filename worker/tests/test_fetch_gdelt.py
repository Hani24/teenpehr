import json
import threading
import time
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import pytest

from teenpehr.fetch import gdelt

ARTLIST = {
    "articles": [
        {
            "url": "https://www.dawn.com/news/1",
            "url_mobile": "",
            "title": "Senate passes budget bill",
            "seendate": "20260929T031500Z",
            "socialimage": "https://images.dawn.com/1.jpg",
            "domain": "dawn.com",
            "language": "English",
            "sourcecountry": "Pakistan",
        },
        {
            "url": "https://urdu.example.pk/2",
            "title": "خبر",
            "seendate": "20260929T041500Z",
            "domain": "urdu.example.pk",
            "language": "Urdu",
            "sourcecountry": "Pakistan",
        },
        {"url": "ftp://bad.example/3", "title": "no http link", "seendate": "20260929T041500Z"},
        {"url": "https://x.example/4", "title": "", "seendate": "20260929T041500Z"},
        "not an object",
    ]
}


def test_artlist_json_entries_newest_first():
    entries = gdelt.parse_artlist(json.dumps(ARTLIST).encode())
    assert [e.link for e in entries] == ["https://urdu.example.pk/2", "https://www.dawn.com/news/1"]
    urdu, dawn = entries
    assert urdu.published == datetime(2026, 9, 29, 4, 15, tzinfo=UTC)
    assert dawn.source_name == "dawn.com" and dawn.image_url == "https://images.dawn.com/1.jpg"
    assert dawn.summary == ""
    assert dawn.raw["sourcecountry"] == "Pakistan" and "url_mobile" not in dawn.raw


def test_control_characters_in_titles_do_not_break_the_json():
    body = b'{"articles":[{"url":"https://a.pk/1","title":"line\x01 one","seendate":"20260929T031500Z"}]}'
    assert gdelt.parse_artlist(body)[0].link == "https://a.pk/1"


def test_empty_answers_are_no_entries():
    assert gdelt.parse_artlist(b"") == []
    assert gdelt.parse_artlist(b"{}") == []


def test_plain_text_errors_are_errors_not_entries():
    with pytest.raises(gdelt.GdeltError, match="too short"):
        gdelt.parse_artlist(b"Your search contained a phrase that was too short.\n")
    with pytest.raises(gdelt.GdeltError):
        gdelt.parse_artlist(b'{"articles": [')


def test_rss_format_is_read_as_a_feed():
    rss = (
        b'<?xml version="1.0"?><rss version="2.0"><channel><title>GDELT</title>'
        b"<item><title>Headline</title><link>https://a.pk/1</link></item></channel></rss>"
    )
    assert [e.link for e in gdelt.parse_artlist(rss)] == ["https://a.pk/1"]


def test_api_url_is_an_artlist_query():
    u = gdelt.api_url("(pakistan OR islamabad) sourcelang:urdu", timespan="12h", maxrecords=999)
    p = urlsplit(u)
    q = {k: v[0] for k, v in parse_qs(p.query).items()}
    assert p.hostname == gdelt.API_HOST and gdelt.is_gdelt(u)
    assert q == {
        "query": "(pakistan OR islamabad) sourcelang:urdu",
        "mode": "artlist",
        "format": "json",
        "timespan": "12h",
        "maxrecords": "250",
        "sort": "datedesc",
    }


def test_slot_spaces_requests_across_threads():
    starts: list[float] = []

    def one():
        with gdelt.slot(0.2):
            starts.append(time.monotonic())

    threads = [threading.Thread(target=one) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    starts.sort()
    assert all(b - a >= 0.19 for a, b in zip(starts, starts[1:], strict=False))
