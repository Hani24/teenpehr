"""The X collector (every 30 minutes): read each group's public Lists through the syndication
endpoint, store the posts, record when each watched handle last posted, and fall back to a paid
API for handles that have gone quiet when a key is configured.

The paid fallback asks about a handle at most once per `x_stale_hours` (remembered in the state
directory), so a handle that simply is not posting costs one call a day, not one per run.

Problems go to ntfy: a list failing or looking unhealthy, X rate-limiting us, twitterapi.io
refusing the key or out of credit, a crash. Each is sent when it starts, again every
REALERT_HOURS while it lasts, and once more when it clears. When every list fails the run is
`failed`, so the command exits non-zero."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from . import log
from .api import WorkerApi
from .config import Settings
from .models import Handle, PostIn, RunFinish
from .notify import ntfy
from .social import twitterapi_io
from .social.x_list import XListClient, XListError, XRateLimited, health

logger = log.get("collect_x")

FALLBACK_STATE = "x-fallback.json"  # handle id -> when twitterapi.io was last asked about it
ALERT_STATE = "x-collect-alerts.json"  # problem key -> when it was last sent to ntfy
REALERT_HOURS = 6.0
_STATE_MAX_AGE = timedelta(days=7)
# twitterapi.io answers that will not change for the next handle: bad key, no credit, rate limit
_FALLBACK_STOP = {401, 402, 403, 429}


@dataclass
class CollectReport:
    lists: int = 0
    lists_ok: int = 0
    posts: int = 0
    new_posts: int = 0
    warnings: list[str] = field(default_factory=list)
    fallback_handles: list[str] = field(default_factory=list)
    alerts: list[str] = field(default_factory=list)
    status: str = "ok"


# ---- small JSON state files (key -> ISO time) ---------------------------------------------------
def _read_times(path: Path) -> dict[str, datetime]:
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    out: dict[str, datetime] = {}
    for k, v in (raw if isinstance(raw, dict) else {}).items():
        try:
            d = datetime.fromisoformat(str(v))
        except ValueError:
            continue
        out[str(k)] = d if d.tzinfo else d.replace(tzinfo=UTC)
    return out


def _write_times(path: Path, times: dict[str, datetime], now: datetime) -> None:
    keep = {k: v.isoformat() for k, v in times.items() if now - v < _STATE_MAX_AGE}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(keep, sort_keys=True))
        os.replace(tmp, path)
    except OSError as e:
        logger.warning("could not save %s: %s", path.name, e)


class _Alerts:
    """ntfy alerts keyed by problem, deduplicated through the state directory."""

    def __init__(self, settings: Settings, now: datetime, *, enabled: bool):
        self.s, self.now, self.enabled = settings, now, enabled
        self.path = settings.state_dir / ALERT_STATE
        self.problems: dict[str, str] = {}
        self.fine: dict[str, str] = {}  # key -> label, for things checked and healthy this run

    def problem(self, key: str, msg: str) -> None:
        self.problems.setdefault(key, msg)
        self.fine.pop(key, None)

    def ok(self, key: str, label: str) -> None:
        if key not in self.problems:
            self.fine[key] = label

    def flush(self, title: str, priority: str) -> list[str]:
        """Send what is due; returns the titles sent."""
        if not self.enabled or not self.s.ntfy_topic:
            return []
        sent: list[str] = []
        last = _read_times(self.path)
        due = [k for k in self.problems if k not in last or self.now - last[k] >= timedelta(hours=REALERT_HOURS)]
        if due and ntfy(self.s.ntfy_topic, title, "\n".join(self.problems.values()), priority=priority):
            sent.append(title)
            for k in self.problems:  # the message listed all of them
                last[k] = self.now
        cleared = [k for k in self.fine if k in last]
        if cleared and ntfy(
            self.s.ntfy_topic,
            "X collector: back to normal",
            "\n".join(f"{self.fine[k]}: fine again" for k in cleared),
            priority="low",
        ):
            sent.append("X collector: back to normal")
            for k in cleared:
                del last[k]
        _write_times(self.path, last, self.now)
        return sent


# ---- the run ------------------------------------------------------------------------------------
def run_collect_x(
    settings: Settings,
    api: WorkerApi,
    client: XListClient,
    *,
    dry_run: bool | None = None,
    now: datetime | None = None,
) -> CollectReport:
    dry = settings.dry_run if dry_run is None else dry_run
    now = now or datetime.now(UTC)
    report = CollectReport()
    alerts = _Alerts(settings, now, enabled=not dry)
    run_id: int | None = None
    lines: list[str] = []
    try:
        config = api.config()
        run_id = None if dry else api.start_run("x_collect")
        posts_by_id: dict[str, PostIn] = {}
        limited = False
        healthy = 0
        for g in sorted(config.groups, key=lambda g: g.order):
            for list_id in g.x_list_ids:
                report.lists += 1
                key, where = f"list:{list_id}", f"list {list_id} ({g.slug})"
                if limited:
                    continue  # X said stop; the next run asks again
                try:
                    posts = client.list_posts(list_id)
                except XRateLimited as e:
                    limited = True
                    msg = f"{where}: X rate-limited us ({e}); the remaining lists wait for the next run"
                    report.warnings.append(msg)
                    logger.warning(msg)
                    alerts.problem("x:rate-limit", msg)
                    continue
                except XListError as e:
                    msg = f"{where}: {e}"
                    report.warnings.append(msg)
                    logger.warning(msg)
                    alerts.problem(key, msg)
                    continue
                except Exception as e:  # noqa: BLE001
                    msg = f"{where}: {type(e).__name__}: {str(e)[:160]}"
                    report.warnings.append(msg)
                    logger.warning(msg)
                    alerts.problem(key, msg)
                    continue
                report.lists_ok += 1
                problem = health(posts, stale_hours=6.0, now=now)
                if problem:
                    msg = f"{where} looks unhealthy: {problem}"
                    report.warnings.append(msg)
                    logger.warning(msg)
                    alerts.problem(key, msg)
                else:
                    healthy += 1
                    alerts.ok(key, where)
                for p in posts:
                    posts_by_id.setdefault(p.platform_id, p)
                lines.append(f"{where}: {len(posts)} posts")
                logger.info(lines[-1])
        if report.lists_ok and not limited:
            alerts.ok("x:rate-limit", "X rate limit")
        all_posts = list(posts_by_id.values())
        report.posts = len(all_posts)

        watched = {h.handle.lower(): h for h in config.handles if h.platform == "x"}
        seen_handles: set[str] = set()
        if all_posts and not dry:
            outs = api.post_posts(run_id, all_posts)
            report.new_posts = sum(1 for o in outs if o.is_new)
            latest: dict[int, datetime] = {}
            by_pid = {p.platform_id: p for p in all_posts}
            for o in outs:
                p = by_pid.get(o.platform_id)
                if o.handle_id and p:
                    latest[o.handle_id] = max(latest.get(o.handle_id, p.posted_at), p.posted_at)
                    seen_handles.add(p.author_handle.lower())
            for hid, when in latest.items():
                try:
                    api.handle_seen(hid, when)
                except Exception as e:  # noqa: BLE001
                    logger.warning("handle_seen %s failed: %s", hid, e)
        elif all_posts:
            report.new_posts = len(all_posts)
            seen_handles = {p.author_handle.lower() for p in all_posts}

        if settings.twitterapi_io_key and not dry:
            _fallback(settings, api, run_id, watched, seen_handles, report, alerts, now)

        all_failed = report.lists > 0 and report.lists_ok == 0
        status = "failed" if all_failed else ("ok" if all_posts else "empty")
        error = f"all {report.lists} X lists failed" if all_failed else None
        if not dry and run_id is not None:
            api.finish_run(run_id, RunFinish(status=status, log="\n".join(lines + report.warnings), error=error))  # type: ignore[arg-type]
        alerts.ok("run", "the collector")
        n = len(alerts.problems)
        if all_failed:
            title = "X collector: X is rate-limiting us" if limited else "X collector: every list failed"
        elif report.lists and not healthy:
            title = "X collector: no list looks healthy"  # the plan's sign that X closed the endpoint
        else:
            title = f"X collector: {n} problem{'s' if n != 1 else ''}"
        report.alerts = alerts.flush(title, "high" if report.lists and not healthy else "default")
        report.status = status
        return report
    except KeyboardInterrupt:
        # systemd stops the unit with SIGINT (a manual stop or its time limit): close the run row so it
        # does not stay "running". The CLI exits 130, which the unit's failure alert reports.
        logger.error("collect-x interrupted")
        if not dry and run_id is not None:
            try:
                api.finish_run(
                    run_id,
                    RunFinish(status="failed", error="interrupted (SIGINT)", log="\n".join(lines + report.warnings)),
                )
            except Exception as e2:  # noqa: BLE001
                logger.error("could not record the interruption: %s", e2)
        report.status = "failed"
        raise
    except Exception as e:
        err = f"{type(e).__name__}: {str(e)[:300]}"
        logger.exception("collect-x failed")
        if not dry and run_id is not None:
            try:
                api.finish_run(run_id, RunFinish(status="failed", error=err, log="\n".join(lines + report.warnings)))
            except Exception as e2:  # noqa: BLE001
                logger.error("could not record the failure: %s", e2)
        alerts.problem("run", f"collector crashed: {err}")
        report.alerts = alerts.flush("X collector crashed", "high")
        report.status = "failed"
        raise


def _fallback(
    settings: Settings,
    api: WorkerApi,
    run_id: int | None,
    watched: dict[str, Handle],
    seen_handles: set[str],
    report: CollectReport,
    alerts: _Alerts,
    now: datetime,
) -> None:
    """twitterapi.io for watched handles silent for `x_stale_hours` and not asked about within
    that long. Any answer counts as asked, including an empty one (suspended or renamed account)
    and a 2xx we could not read (it was paid for); a network error or a 5xx does not, so the next
    run tries again."""
    path = settings.state_dir / FALLBACK_STATE
    asked = _read_times(path)
    every = timedelta(hours=settings.x_stale_hours)
    for key, h in watched.items():
        if key in seen_handles or not h.last_post_at:
            continue
        if now - h.last_post_at < every:
            continue
        last = asked.get(str(h.id))
        if last and now - last < every:
            continue
        try:
            fb = twitterapi_io.last_tweets(settings.twitterapi_io_key or "", h.handle)
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            msg = f"twitterapi.io answered {code} for @{h.handle}"
            if code in _FALLBACK_STOP:
                hint = {402: " (out of credit?)", 401: " (bad key?)", 403: " (key refused)"}.get(code, "")
                msg += f"{hint}; no more fallback calls this run"
                report.warnings.append(msg)
                logger.warning(msg)
                if code != 429:
                    alerts.problem("fallback", msg)
                return
            report.warnings.append(msg)
            logger.warning(msg)
            if code < 500:  # this handle's own problem: do not ask again for a day
                asked[str(h.id)] = now
                _write_times(path, asked, now)
            continue
        except httpx.HTTPError as e:  # network trouble: nothing was billed, the next run tries again
            msg = f"fallback for @{h.handle} failed: {type(e).__name__}: {str(e)[:160]}"
            report.warnings.append(msg)
            logger.warning(msg)
            continue
        except Exception as e:  # noqa: BLE001 - a 2xx we cannot read; retrying each run would pay each time
            msg = f"fallback answer for @{h.handle} unreadable: {type(e).__name__}: {str(e)[:160]}"
            report.warnings.append(msg)
            logger.warning(msg)
            asked[str(h.id)] = now
            _write_times(path, asked, now)
            continue
        try:
            if fb:
                outs = api.post_posts(run_id, fb)
                report.new_posts += sum(1 for o in outs if o.is_new)
                api.handle_seen(h.id, max(p.posted_at for p in fb), fallback_used=True)
            else:
                api.handle_seen(h.id, None, fallback_used=True)
        except Exception as e:  # noqa: BLE001 - keep the answer unrecorded so the next run stores it
            msg = f"storing the fallback for @{h.handle} failed: {type(e).__name__}: {str(e)[:160]}"
            report.warnings.append(msg)
            logger.warning(msg)
            continue
        asked[str(h.id)] = now
        _write_times(path, asked, now)
        report.fallback_handles.append(h.handle)
        alerts.ok("fallback", "twitterapi.io fallback")
