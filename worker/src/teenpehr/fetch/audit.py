"""Source audit: fetch every source of a seed file (or the given URLs) once, exactly as a run would
(fetch.kinds.read: same fetcher, routes, parsers, robots.txt for sitemaps and GDELT), and say for
each whether it works today and why not.

    uv run python -m teenpehr.fetch.audit ../web/db/seed/sources.json --out out/audit.json
    uv run python -m teenpehr.fetch.audit ../web/db/seed/sources.json --write-seed   # record results in the seed
    uv run python -m teenpehr.fetch.audit --url https://example.com/feed --kind rss

Etiquette: one request per host at a time (the Fetcher's host locks) and at least `--host-spacing`
seconds between two requests to one host; 429s and their cooldowns are honoured across processes;
robots.txt is read once per host and recorded for every source (feeds are fetched as feeds, so for
rss, gnews and youtube the verdict is information, not a gate). By default the Germany route is never
tried: a host that is unreachable directly (DNS, connect, TLS reset, connect timeout) is recorded as
`needs_germany`, never worked around. With `--germany` (when the tunnel is up) sources are read as a
run reads them: a `germany` row through the tunnel, a `direct` row directly and through the tunnel only
when its host is blocked (DNS, connect or TLS failure; the Fetcher's own fallback). Never to get past a
429 or a bot wall.
No writes anywhere except --out and --write-seed.

Statuses: ok, stale (entries, but none in `--stale-days`), empty (a readable body with no entries),
needs_germany, germany_down (--germany: the tunnel did not answer), challenge (a bot wall: 401/403/503
with a WAF signature; never evaded), gone (404/410), http_error, parse_error, timeout, rate_limited,
robots_disallowed, refused, unsupported."""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from .. import log
from ..config import Settings
from . import kinds
from .article import ArticleFetcher
from .http import Fetcher, FetchResult, host_of

logger = log.get("fetch.audit")

STALE_DAYS = 21.0  # no entry for three weeks: dormant, not just slow
SLOW_DAYS = 3.0  # an ok source whose newest entry is older than this gets a note
HOST_SPACING_S = 2.0
_CONNECT_SIGNS = (
    "Could not resolve",
    "CouldNotResolve",
    "Failed to connect",
    "Connection timed out",
    "Connection refused",
    "Connection reset",
    "SSL connect error",
    "Recv failure",
    "Send failure",
    "SSL_ERROR_SYSCALL",
    "unexpected eof",
)


@dataclass
class Check:
    group: str
    name: str
    kind: str
    url: str
    route: str
    status: str
    why: str = ""
    http: int = 0
    items: int = 0
    newest_h: float | None = None
    ms: int = 0
    final_url: str = ""
    content_type: str = ""
    robots: str = "n/a"  # allowed | disallowed | unreachable | n/a
    checked_at: str = ""
    sample: str = ""  # the newest entry's title, to eyeball the feed
    feed_title: str = ""  # the feed's own title (a YouTube channel's name, a sitemap's publication)
    via: str = "direct"  # the route that answered (germany only with --germany)


class PacedFetcher:
    """A Fetcher whose requests to one host start at least `spacing_s` after the previous one to
    that host ended (the Fetcher itself only serialises them)."""

    def __init__(self, fetcher: Fetcher, spacing_s: float, *, fallback: bool = False):
        self._f = fetcher
        self._spacing = spacing_s
        self._fallback = fallback  # the Fetcher's Germany fallback for blocked hosts (--germany only)
        self._last: dict[str, float] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock(self, host: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(host, threading.Lock())

    def get(self, url: str, **kw: Any) -> FetchResult:
        kw["allow_fallback"] = self._fallback
        host = host_of(url)
        with self._lock(host):
            wait = self._last.get(host, float("-inf")) + self._spacing - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            try:
                return self._f.get(url, **kw)
            finally:
                self._last[host] = time.monotonic()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._f, name)


def _challenge(res: FetchResult) -> str | None:
    h = res.headers
    if h.get("cf-mitigated") == "challenge":
        return "Cloudflare challenge"
    server = h.get("server", "").lower()
    if "x-datadome" in h or "datadome" in server:
        return "DataDome"
    if res.status in (401, 403, 503):
        if "cloudflare" in server:
            return "Cloudflare"
        if "akamai" in server or "akamaighost" in server:
            return "Akamai"
        if "x-amz-cf-id" in h or "cloudfront" in server:
            return "CloudFront"
        if "x-sucuri-id" in h or "sucuri" in server:
            return "Sucuri"
    return None


def classify(feed: kinds.Feed, *, now: datetime, stale_days: float = STALE_DAYS) -> tuple[str, str]:
    """(status, why) for one read."""
    res = feed.res
    err = res.error or ""
    if res.refused:
        return "refused", err
    if res.rate_limited:
        return "rate_limited", err
    if err.startswith("kind "):
        return "unsupported", err
    if err.startswith("robots.txt"):
        return "robots_disallowed", err
    # A transport error (no HTTP answer), possibly on a redirect hop after a first 30x.
    if err and not res.ok and not err.startswith("http "):
        if res.blocked or any(s.lower() in err.lower() for s in _CONNECT_SIGNS):
            return "needs_germany", f"unreachable directly: {err[:160]}"
        if "certificate" in err.lower() or "SSL" in err:
            return "needs_germany", f"TLS answered by someone else (ISP block page?): {err[:160]}"
        if res.timed_out:
            return "timeout", err[:200]
        return "http_error", err[:200]
    wall = _challenge(res)
    if wall and not res.ok:
        return "challenge", f"{wall} (http {res.status}); needs a tier-2 browser, never evaded"
    if res.status in (404, 410):
        return "gone", f"http {res.status}"
    if not res.ok:
        return "http_error", err or f"http {res.status}"
    if feed.error:
        return "parse_error", feed.error
    entries = feed.entries or []
    if not entries:
        ct = res.headers.get("content-type", "")
        return "empty", f"no entries in a {ct or 'body'} of {len(res.content)} bytes"
    dated = [e.published for e in entries if e.published]
    if not dated:
        return "ok", "entries carry no dates"
    age_h = (now - max(dated)).total_seconds() / 3600
    if age_h > stale_days * 24:
        return "stale", f"newest entry {age_h / 24:.0f} days old"
    if age_h > SLOW_DAYS * 24:
        return "ok", f"slow: newest entry {age_h / 24:.0f} days old"
    return "ok", ""


def check_source(
    fetcher: Any,
    robots: ArticleFetcher,
    src: dict[str, Any],
    *,
    now: datetime,
    stale_days: float,
    germany: bool = False,
) -> Check:
    kind = src.get("kind", "rss")
    url = src["url"]

    # Direct, whatever the seed's route: the audit says what this machine reaches on its own. With
    # `germany`, the row's own route (the fetcher then falls back to Germany for a blocked host).
    route = src.get("route", "direct") if germany else "direct"
    s = SimpleNamespace(kind=kind, url=url, route=route)
    t0 = time.monotonic()
    try:
        feed = kinds.read(fetcher, s, conditional=False, allowed=robots.allowed)
    except Exception as e:  # noqa: BLE001 - an audit reports, it never stops
        feed = kinds.Feed(FetchResult(url=url, status=0, error=f"{type(e).__name__}: {e}"))
    status, why = classify(feed, now=now, stale_days=stale_days)
    via = "germany" if route == "germany" or feed.res.fell_back else "direct"
    if germany and status == "needs_germany":
        status, why = "germany_down", f"blocked directly and the Germany route did not answer: {feed.res.error[:140]}"
    if not germany and status == "ok" and src.get("route") == "germany":
        # Germany is for reach only: a host this machine reaches should be read directly (a run still falls
        # back to Germany if it is blocked again), and a germany row goes nowhere while the tunnel is down.
        why = "; ".join(x for x in (why, "reachable directly: set its route to direct") if x)
    res = feed.res
    entries = feed.entries or []
    dated = [e for e in entries if e.published]
    newest = max(dated, key=lambda e: e.published) if dated else (entries[0] if entries else None)
    verdict = "n/a"
    if status not in ("needs_germany", "refused", "unsupported", "rate_limited"):
        # robots.txt was already read for sitemap and GDELT sources; for feeds it is information only.
        try:
            verdict = robots.robots_verdict(url, via)
        except Exception:  # noqa: BLE001
            verdict = "n/a"
    return Check(
        group=src.get("group", ""),
        name=src.get("name", url[:40]),
        kind=kind,
        url=url,
        route=src.get("route", "direct"),
        status=status,
        why=why,
        http=res.status,
        items=len(entries),
        newest_h=round((now - newest.published).total_seconds() / 3600, 1) if newest and newest.published else None,
        ms=int((time.monotonic() - t0) * 1000),
        final_url=res.final_url if res.final_url and res.final_url != url else "",
        content_type=res.headers.get("content-type", "")[:60],
        robots=verdict,
        checked_at=now.strftime("%Y-%m-%dT%H:%MZ"),
        via=via,
        sample=(newest.title[:100] if newest else ""),
        feed_title=((newest.feed_title or newest.source_name or "")[:80] if newest else ""),
    )


def run(
    rows: list[dict[str, Any]],
    settings: Settings,
    *,
    workers: int = 6,
    host_spacing_s: float = HOST_SPACING_S,
    stale_days: float = STALE_DAYS,
    germany: bool = False,
) -> list[Check]:
    fetcher = PacedFetcher(
        Fetcher(settings, state_file=settings.state_dir / "audit-cache.json"), host_spacing_s, fallback=germany
    )
    robots = ArticleFetcher(fetcher)  # type: ignore[arg-type]
    now = datetime.now(UTC)
    order = kinds.interleave_by_host([r["url"] for r in rows])
    out: list[Check | None] = [None] * len(rows)

    def one(i: int) -> None:
        c = check_source(fetcher, robots, rows[i], now=now, stale_days=stale_days, germany=germany)
        out[i] = c
        logger.info("%-13s %-28s %s %s", c.status, c.name[:28], c.items, c.why[:80])

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(one, order))
    return [c for c in out if c is not None]


def summarise(checks: list[Check]) -> str:
    lines = [f"{'status':17} {'group':12} {'kind':7} {'items':>5} {'newest':>7}  name / why"]
    for c in sorted(checks, key=lambda c: (c.status != "ok", c.status, c.group, c.name)):
        newest = f"{c.newest_h:.0f}h" if c.newest_h is not None else "-"
        why = f" - {c.why}" if c.why else ""
        lines.append(f"{c.status:17} {c.group:12} {c.kind:7} {c.items:>5} {newest:>7}  {c.name}{why}")
    counts = Counter(c.status for c in checks)
    lines.append("")
    lines.append(", ".join(f"{k} {v}" for k, v in counts.most_common()) + f"  (of {len(checks)})")
    return "\n".join(lines)


def write_seed(path: Path, rows: list[dict[str, Any]], checks: list[Check]) -> None:
    """Record each check in the seed row it came from (`check`), matched by group and URL."""
    by_key = {(c.group, c.url): c for c in checks}
    for r in rows:
        c = by_key.get((r.get("group", ""), r["url"]))
        if c is None:
            continue
        r["check"] = {
            "status": c.status,
            **({"why": c.why} if c.why else {}),
            "items": c.items,
            **({"newest_h": c.newest_h} if c.newest_h is not None else {}),
            **({"robots": c.robots} if c.robots != "n/a" else {}),
            **({"via": c.via} if c.via != "direct" else {}),
            "checked_at": c.checked_at,
        }
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m teenpehr.fetch.audit", description=__doc__.split("\n\n")[0])
    ap.add_argument("seed", nargs="?", help="sources.json (web/db/seed)")
    ap.add_argument("--url", action="append", default=[], help="check this URL instead (repeatable)")
    ap.add_argument("--kind", default="rss", help="kind for --url checks")
    ap.add_argument("--group", help="only this group slug")
    ap.add_argument("--match", help="only sources whose name or URL contains this text")
    ap.add_argument("--status", help="only seed rows whose recorded check has this status (re-check)")
    ap.add_argument("--out", help="write the checks as JSON here")
    ap.add_argument("--write-seed", action="store_true", help="record each check in the seed file")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--host-spacing", type=float, default=HOST_SPACING_S)
    ap.add_argument("--stale-days", type=float, default=STALE_DAYS)
    ap.add_argument("--germany", action="store_true", help="use the Germany route as a run does (tunnel up)")
    args = ap.parse_args(argv)
    log.setup("INFO")

    all_rows: list[dict[str, Any]] = []
    if args.url:
        rows = [{"group": "", "name": u[:40], "kind": args.kind, "url": u} for u in args.url]
    elif args.seed:
        all_rows = json.loads(Path(args.seed).read_text(encoding="utf-8"))
        rows = [
            r
            for r in all_rows
            if (not args.group or r.get("group") == args.group)
            and (not args.match or args.match.lower() in (r.get("name", "") + r["url"]).lower())
            and (not args.status or (r.get("check") or {}).get("status") == args.status)
        ]
    else:
        ap.error("give a seed file or --url")
    settings = Settings()
    settings.state_dir.mkdir(parents=True, exist_ok=True)
    checks = run(
        rows,
        settings,
        workers=args.workers,
        host_spacing_s=args.host_spacing,
        stale_days=args.stale_days,
        germany=args.germany,
    )
    print(summarise(checks))
    if args.out:
        data = json.dumps([asdict(c) for c in checks], ensure_ascii=False, indent=2)
        Path(args.out).write_text(data, encoding="utf-8")
    if args.write_seed and args.seed:
        write_seed(Path(args.seed), all_rows, checks)
    return 0


if __name__ == "__main__":
    sys.exit(main())
