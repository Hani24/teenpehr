"""Today's Claude usage in API-equivalent dollars, shared by edition runs and the job runner (decision
D13: DAILY_BUDGET_USD caps both). It is the file pipeline.EditionRun keeps, `out/state/spend-<date>.json`
holding `{"usd": n}`, dated in settings.tz. An addition here takes an exclusive lock on a sibling lock
file and replaces the file atomically, so two jobs (or a job and a translate-url test) never lose each
other's cost."""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from ..config import Settings

LOCK_NAME = "spend.lock"


def local_now(s: Settings, now: datetime | None = None) -> datetime:
    tz = ZoneInfo(s.tz)
    return now.astimezone(tz) if now else datetime.now(tz)


def spend_file(s: Settings, now: datetime | None = None) -> Path:
    return s.state_dir / f"spend-{local_now(s, now):%Y-%m-%d}.json"


def _read(path: Path) -> float:
    try:
        v = json.loads(path.read_text()).get("usd", 0.0)
        return max(0.0, float(v))
    except (OSError, ValueError, TypeError, AttributeError):
        return 0.0


def spent_today(s: Settings, now: datetime | None = None) -> float:
    return _read(spend_file(s, now))


def add_spend(s: Settings, usd: float, now: datetime | None = None) -> float:
    """Add `usd` to today's total and return the new total (the old one when there is nothing to add)."""
    path = spend_file(s, now)
    if not usd or usd <= 0:
        return _read(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.parent / LOCK_NAME, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            total = round(_read(path) + usd, 4)
            tmp = path.with_suffix(f".{os.getpid()}.tmp")
            with contextlib.suppress(OSError):
                tmp.write_text(json.dumps({"usd": total}))
                os.replace(tmp, path)
            return total
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def budget_left(s: Settings, now: datetime | None = None) -> float:
    return s.daily_budget_usd - spent_today(s, now)


def seconds_to_midnight(s: Settings, now: datetime | None = None) -> int:
    """Seconds until the budget day (settings.tz) turns over, plus a minute, at most a day."""
    t = local_now(s, now)
    midnight = (t + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(min(86_400, (midnight - t).total_seconds() + 60))
