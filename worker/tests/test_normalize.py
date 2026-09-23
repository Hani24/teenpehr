from teenpehr.normalize import (
    canonical_url,
    content_hash,
    normalize_urdu,
    slugify,
    strip_outlet_suffix,
    title_key,
)


def test_canonical_url_strips_tracking_www_and_slash():
    a = canonical_url("https://www.dawn.com/news/123/?utm_source=rss&utm_medium=feed&ref=tw#top")
    b = canonical_url("http://dawn.com/news/123")
    assert a == b == "dawn.com/news/123"


def test_canonical_url_keeps_meaningful_query_sorted():
    assert canonical_url("https://x.test/a?b=2&a=1&utm_x=9") == "x.test/a?a=1&b=2"


def test_canonical_url_amp_variants_collapse():
    assert canonical_url("https://amp.geo.tv/latest/1-rain/amp") == "geo.tv/latest/1-rain"


def test_title_key_and_hash_stable():
    assert title_key("  PM chairs   Meeting!! ") == "pm chairs meeting"
    assert content_hash("dawn.com/news/1", "A title") == content_hash("dawn.com/news/1", "a TITLE")
    assert content_hash("dawn.com/news/1", "A") != content_hash("dawn.com/news/2", "A")


def test_strip_outlet_suffix():
    assert strip_outlet_suffix("PM chairs meeting on IMF review - Dawn") == "PM chairs meeting on IMF review"
    assert strip_outlet_suffix("Budget 2026-27 explained | The Express Tribune") == "Budget 2026-27 explained"
    assert strip_outlet_suffix("No suffix here") == "No suffix here"


def test_normalize_urdu_maps_arabic_codepoints():
    # Arabic yeh, kaf, heh -> Urdu yeh, keheh, heh goal
    assert normalize_urdu("يكه") == "یکہ"
    assert normalize_urdu("ة") == "ۃ"
    assert normalize_urdu("پاکستان") == "پاکستان"


def test_normalize_urdu_digits():
    assert normalize_urdu("۲۰۲۶ اور ٣", "latn") == "2026 اور 3"
    assert normalize_urdu("2026", "arabext") == "۲۰۲۶"
    assert normalize_urdu("2026", "keep") == "2026"


def test_slugify():
    assert slugify("IMF review: talks resume!") == "imf-review-talks-resume"
    assert slugify("!!!") == "story"
