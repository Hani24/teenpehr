import json
from datetime import UTC, datetime

import pytest

from conftest import fixture_text
from teenpehr.fetch import xlist_audit as xa
from teenpehr.social.x_list import XListError, XRateLimited

NOW = datetime(2026, 9, 23, 16, 0, tzinfo=UTC)  # the fixture's newest post is 14:17 UTC that day
PAGE = fixture_text("x_list_84839422.html")  # X's own "Official Twitter Accounts" list


def test_list_url_takes_ids_and_refuses_owner_slugs_before_any_request():
    assert xa.list_url("84839422").endswith("/list-id/84839422")
    assert xa.list_url("https://x.com/i/lists/84839422") == xa.list_url("84839422")
    for slug in ("dawn_com/pakistan-journalists", "https://twitter.com/dawn_com/lists/pakistan-journalists"):
        with pytest.raises(ValueError, match="numeric id"):
            xa.list_url(slug)
    assert xa.list_url("http://www.twitter.com/i/lists/84839422/") == xa.list_url("84839422")
    # Arabic-Indic or other Unicode digits, or a trailing newline, would not fit list_id's ^[0-9]{1,25}$ check
    for bad in ("123", "a/b/c", "dawn com/x", "../etc", "٨٤٨٣٩٤٢٢", "84839422\n12"):
        with pytest.raises(ValueError):
            xa.list_url(bad)


def test_page_meta_reads_the_lists_own_header():
    assert xa.page_meta(PAGE) == {
        "list_id": "84839422",
        "name": "Official Twitter Accounts",
        "owner": "X",
        "members": 81,
    }
    assert xa.page_meta("<html>no data</html>") == {}


def test_check_counts_freshness_overlap_and_relevance():
    c = xa.check_page(PAGE, "84839422", "world", {"sports", "nobody"}, now=NOW)
    assert (c.ok, c.list_id, c.entries, c.authors, c.members) == (True, "84839422", 97, 14, 81)
    assert c.newest_h == pytest.approx(1.7, abs=0.1) and c.overlap == ["Sports"]
    assert c.sample_authors[0] == "Sports" and 0 <= c.relevant_share <= 1
    ok, why = xa.verdict(c, min_relevant=0.99)
    assert not ok and "post on world" in why
    ok, _ = xa.verdict(c, min_relevant=0.0)
    assert ok
    stale = xa.check_page(PAGE, "84839422", "world", set(), now=datetime(2026, 9, 30, tzinfo=UTC))
    assert xa.verdict(stale, min_relevant=0.0)[1].startswith("newest post")


def test_proposal_shape_matches_what_the_admin_and_apply_sources_read(tmp_path):
    c = xa.check_page(PAGE, "84839422", "world", set(), now=NOW)
    p = xa.to_proposal(c)
    assert p["group"] == "world" and p["list_id"] == "84839422" and p["url"] == "https://x.com/i/lists/84839422"
    assert p["owner"] == "X" and p["members"] == 81 and p["entries"] == 97 and p["verified_at"]
    path = tmp_path / "x-list-proposals.json"
    path.write_text(
        json.dumps([{"group": "world", "list_id": "84839422", "notes": "old"}, {"group": "india", "list_id": "5"}])
    )
    out = xa.merge(path, [p])
    saved = json.loads(path.read_text())
    assert saved == out and [x["group"] for x in saved] == ["india", "world"] and saved[1]["notes"] != "old"


def test_run_stops_at_a_rate_limit_and_names_what_is_left():
    calls: list[str] = []

    def get(url):
        calls.append(url)
        if len(calls) == 2:
            raise XRateLimited("http 429")
        if len(calls) == 1:
            raise XListError("no __NEXT_DATA__ in response")
        return PAGE

    checks, left = xa.run(["1111111", "2222222", "3333333"], "world", get, set(), spacing_s=0, now=NOW)
    assert [c.ok for c in checks] == [False, False] and "rate limited" in checks[1].error
    assert left == ["3333333"] and len(calls) == 2
    checks, left = xa.run(["not a ref", "84839422"], "world", lambda u: PAGE, set(), spacing_s=0, now=NOW)
    assert [c.ok for c in checks] == [False, True] and left == []
