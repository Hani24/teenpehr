import gzip
from datetime import UTC, datetime

from teenpehr.fetch import sitemap

NEWS = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://www.example.pk/news/older-story</loc>
    <news:news>
      <news:publication><news:name>Example Times</news:name><news:language>en</news:language></news:publication>
      <news:publication_date>2026-09-28T09:00:00+05:00</news:publication_date>
      <news:title>Older headline &amp; more</news:title>
      <news:keywords>Pakistan, economy , IMF</news:keywords>
    </news:news>
  </url>
  <url>
    <loc>/news/newer-story</loc>
    <lastmod>2026-09-29T02:10:00Z</lastmod>
    <news:news>
      <news:publication><news:name>Example Times</news:name><news:language>ur</news:language></news:publication>
      <news:publication_date>2026-09-29T07:00:00+05:00</news:publication_date>
      <news:title>\xd9\x88\xd8\xb2\xdb\x8c\xd8\xb1\xd8\xa7\xd8\xb9\xd8\xb8\xd9\x85 \xda\xa9\xd8\xa7 \xd8\xa7\xd8\xac\xd9\x84\xd8\xa7\xd8\xb3</news:title>
    </news:news>
    <image:image><image:loc>https://cdn.example.pk/img/1.jpg</image:loc></image:image>
  </url>
  <url>
    <loc>https://www.example.pk/plain-page</loc>
    <lastmod>2026-09-29T01:00:00Z</lastmod>
  </url>
  <url>
    <loc>javascript:alert(1)</loc>
    <news:news><news:title>Bad link</news:title></news:news>
  </url>
</urlset>"""

INDEX = b"""<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://www.example.pk/sitemap-news-2.xml</loc><lastmod>2026-09-27T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>https://www.example.pk/sitemap-news-3.xml</loc><lastmod>2026-09-29T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>https://www.example.pk/sitemap-news-1.xml</loc><lastmod>2026-09-20T00:00:00Z</lastmod></sitemap>
</sitemapindex>"""


def test_news_sitemap_entries_newest_first_with_metadata():
    sm = sitemap.parse_sitemap(NEWS, "https://www.example.pk/sitemap-news.xml")
    assert not sm.is_index and not sm.truncated
    # the plain page (no news:news) and the non-http link are skipped: a headline is never made up
    assert [e.link for e in sm.entries] == [
        "https://www.example.pk/news/newer-story",  # relative loc resolved against the sitemap
        "https://www.example.pk/news/older-story",
    ]
    newer, older = sm.entries
    assert newer.title == "وزیراعظم کا اجلاس"
    assert newer.published == datetime(2026, 9, 29, 2, 0, tzinfo=UTC)
    assert newer.updated == datetime(2026, 9, 29, 2, 10, tzinfo=UTC)
    assert newer.image_url == "https://cdn.example.pk/img/1.jpg"
    assert newer.summary == "" and newer.source_name == "Example Times"
    assert newer.raw["news"]["language"] == "ur"
    assert older.title == "Older headline & more"
    assert older.categories == ["Pakistan", "economy", "IMF"]
    assert older.published == datetime(2026, 9, 28, 4, 0, tzinfo=UTC)


def test_sitemap_index_children_newest_first():
    sm = sitemap.parse_sitemap(INDEX)
    assert sm.is_index and sm.entries == []
    assert sm.children == [
        "https://www.example.pk/sitemap-news-3.xml",
        "https://www.example.pk/sitemap-news-2.xml",
        "https://www.example.pk/sitemap-news-1.xml",
    ]


def test_gzipped_sitemap_is_unpacked():
    sm = sitemap.parse_sitemap(gzip.compress(NEWS), "https://www.example.pk/sitemap-news.xml.gz")
    assert len(sm.entries) == 2
    # without a base URL a relative <loc> cannot be placed, so it is dropped rather than guessed
    assert len(sitemap.parse_sitemap(NEWS).entries) == 1


def test_truncated_sitemap_keeps_what_came_before_the_cut():
    cut = NEWS[: NEWS.index(b"<loc>/news/newer-story")]
    sm = sitemap.parse_sitemap(cut)
    assert sm.truncated
    assert [e.title for e in sm.entries] == ["Older headline & more"]


def test_garbage_and_entity_tricks_never_raise():
    assert sitemap.parse_sitemap(b"").entries == []
    assert sitemap.parse_sitemap(b"not xml at all").entries == []
    assert sitemap.parse_sitemap(b"\x1f\x8bnot really gzip").entries == []
    bomb = (
        b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">'
        b'<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;">]><urlset><url><loc>https://a.pk/x</loc>'
        b"<news><title>&lol3;</title></news></url></urlset>"
    )
    sm = sitemap.parse_sitemap(bomb)  # small expansions are harmless; expat caps amplification
    assert all(len(e.title) < 10_000 for e in sm.entries)
    external = (
        b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/passwd">]>'
        b"<urlset><url><loc>https://a.pk/y</loc><news><title>&ext;</title></news></url></urlset>"
    )
    sm = sitemap.parse_sitemap(external)  # external entities are never fetched
    assert all("root:" not in e.title for e in sm.entries)
