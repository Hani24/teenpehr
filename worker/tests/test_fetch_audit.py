import json
from datetime import UTC, datetime, timedelta

from teenpehr.fetch import audit, kinds
from teenpehr.fetch.http import FetchResult
from teenpehr.fetch.rss import Entry

NOW = datetime(2026, 9, 29, 4, 0, tzinfo=UTC)


def feed(res: FetchResult, entries=None, error=None) -> kinds.Feed:
    return kinds.Feed(res, entries, error)


def entry(hours_old: float | None) -> Entry:
    when = NOW - timedelta(hours=hours_old) if hours_old is not None else None
    return Entry(title="t", link="https://a.pk/1", summary="", published=when)


def test_ok_slow_stale_and_empty():
    ok = FetchResult(url="u", status=200, content=b"<rss/>")
    assert audit.classify(feed(ok, [entry(2)]), now=NOW) == ("ok", "")
    assert audit.classify(feed(ok, [entry(24 * 5)]), now=NOW) == ("ok", "slow: newest entry 5 days old")
    assert audit.classify(feed(ok, [entry(24 * 30)]), now=NOW)[0] == "stale"
    assert audit.classify(feed(ok, [entry(None)]), now=NOW) == ("ok", "entries carry no dates")
    assert audit.classify(feed(ok, []), now=NOW)[0] == "empty"
    assert audit.classify(feed(ok, None, "parse: bad"), now=NOW) == ("parse_error", "parse: bad")


def test_unreachable_hosts_need_germany_even_after_a_redirect_hop():
    reset = FetchResult(url="u", status=0, error="SSLError: curl: (35) Recv failure: Connection reset by peer")
    assert audit.classify(feed(reset), now=NOW)[0] == "needs_germany"
    after_301 = FetchResult(url="u", status=301, error="SSLError: curl: (35) Recv failure: Connection reset by peer")
    assert audit.classify(feed(after_301), now=NOW)[0] == "needs_germany"
    dns = FetchResult(url="u", status=0, error="CouldNotResolve: could not resolve x", blocked=True)
    assert audit.classify(feed(dns), now=NOW)[0] == "needs_germany"
    connect = FetchResult(url="u", status=0, error="Timeout: curl: (28) Connection timed out after 25002 ms")
    assert audit.classify(feed(connect), now=NOW)[0] == "needs_germany"
    slow = FetchResult(url="u", status=0, error="Timeout: Operation timed out after 25000 ms", timed_out=True)
    assert audit.classify(feed(slow), now=NOW)[0] == "timeout"


def test_walls_limits_and_refusals():
    cf = FetchResult(url="u", status=403, error="http 403", headers={"server": "cloudflare"})
    assert audit.classify(feed(cf), now=NOW)[0] == "challenge"
    challenge = FetchResult(url="u", status=403, error="http 403", headers={"cf-mitigated": "challenge"})
    assert "never evaded" in audit.classify(feed(challenge), now=NOW)[1]
    assert audit.classify(feed(FetchResult(url="u", status=404, error="http 404")), now=NOW) == ("gone", "http 404")
    limited = FetchResult(url="u", status=429, error="http 429", rate_limited=True)
    assert audit.classify(feed(limited), now=NOW)[0] == "rate_limited"
    robots = FetchResult(url="u", status=0, error="robots.txt disallows this URL for our agent")
    assert audit.classify(feed(robots), now=NOW)[0] == "robots_disallowed"
    refused = FetchResult(url="u", status=0, error="refused: 10.0.0.1 is not a public address", refused=True)
    assert audit.classify(feed(refused), now=NOW)[0] == "refused"
    kind = FetchResult(url="u", status=0, error="kind telegram is not fetched by this worker")
    assert audit.classify(feed(kind), now=NOW)[0] == "unsupported"


def test_write_seed_records_checks_by_group_and_url(tmp_path):
    rows = [
        {"group": "pakistan", "name": "A", "kind": "rss", "url": "https://a.pk/feed"},
        {"group": "india", "name": "A", "kind": "rss", "url": "https://a.pk/feed"},
    ]
    check = audit.Check(
        group="pakistan", name="A", kind="rss", url="https://a.pk/feed", route="direct", status="ok",
        items=3, newest_h=1.5, robots="allowed", checked_at="2026-09-29T04:00Z",
    )  # fmt: skip
    path = tmp_path / "sources.json"
    audit.write_seed(path, rows, [check])
    saved = json.loads(path.read_text())
    assert saved[0]["check"] == {
        "status": "ok",
        "items": 3,
        "newest_h": 1.5,
        "robots": "allowed",
        "checked_at": "2026-09-29T04:00Z",
    }
    assert "check" not in saved[1]


def test_paced_fetcher_never_falls_back_to_germany():
    class F:
        def __init__(self):
            self.kw = None

        def get(self, url, **kw):
            self.kw = kw
            return FetchResult(url=url, status=200)

    inner = F()
    audit.PacedFetcher(inner, 0).get("https://a.pk/x", route="direct")
    assert inner.kw == {"route": "direct", "allow_fallback": False}


class _RouteFetcher:
    """A Fetcher stand-in: direct is reset (blocked from Pakistan); germany serves a feed or is down. With
    allow_fallback, a blocked direct read goes on to Germany, as the real Fetcher does."""

    def __init__(self, germany_up: bool):
        self.germany_up = germany_up
        self.routes: list[str] = []

    def _germany(self, url):
        self.routes.append("germany")
        if not self.germany_up:
            return FetchResult(url=url, status=0, error="Failed to connect to 127.0.0.1 port 1080")
        body = b"<rss><channel><item><title>T</title><link>https://a.in/1</link></item></channel></rss>"
        return FetchResult(url=url, status=200, content=body, final_url=url)

    def get(self, url, **kw):
        if kw.get("route") == "germany":
            return self._germany(url)
        self.routes.append("direct")
        res = FetchResult(url=url, status=0, error="SSLError: curl: (35) Recv failure: Connection reset by peer")
        if kw.get("allow_fallback"):
            res = self._germany(url)
            res.fell_back = True
        return res


class _Robots:
    def allowed(self, url, route):
        return True

    def robots_verdict(self, url, route):
        return "allowed"


def _check(germany_up: bool, row: dict, germany: bool):
    f = _RouteFetcher(germany_up)
    paced = audit.PacedFetcher(f, 0, fallback=germany)
    return audit.check_source(paced, _Robots(), row, now=NOW, stale_days=21, germany=germany), f.routes


def test_germany_flag_reads_as_a_run_does():
    row = {"group": "india", "name": "Blocked", "kind": "rss", "url": "https://a.in/feed", "route": "germany"}
    direct_row = dict(row, route="direct", name="Direct")
    # default: direct only, whatever the row says, and never a fallback
    c, routes = _check(True, row, germany=False)
    assert (c.status, c.via, routes) == ("needs_germany", "direct", ["direct"])
    c, routes = _check(True, direct_row, germany=False)
    assert (c.status, routes) == ("needs_germany", ["direct"])
    # --germany: a germany row goes through the tunnel; a direct row tries direct first, then falls back
    c, routes = _check(True, row, germany=True)
    assert (c.status, c.via, c.items, routes) == ("ok", "germany", 1, ["germany"])
    c, routes = _check(True, direct_row, germany=True)
    assert (c.status, c.via, routes) == ("ok", "germany", ["direct", "germany"])
    # the tunnel being down is not the host's fault
    c, _ = _check(False, row, germany=True)
    assert c.status == "germany_down" and "did not answer" in c.why


def test_a_germany_row_reachable_directly_is_flagged():
    class Open(_RouteFetcher):
        def get(self, url, **kw):
            self.routes.append(kw.get("route", "direct"))
            return self._germany(url)  # the same feed body, answered directly

    row = {"group": "india", "name": "Open", "kind": "rss", "url": "https://a.in/feed", "route": "germany"}
    f = Open(True)
    c = audit.check_source(audit.PacedFetcher(f, 0), _Robots(), row, now=NOW, stale_days=21)
    assert c.status == "ok" and c.via == "direct" and "set its route to direct" in c.why
    c = audit.check_source(audit.PacedFetcher(f, 0), _Robots(), dict(row, route="direct"), now=NOW, stale_days=21)
    assert "route" not in c.why
