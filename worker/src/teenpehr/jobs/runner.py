"""The job runner (`teenpehr jobs`): claims jobs the site queued (docs/API.md § Jobs) and does them, one
at a time by default (JOBS_CONCURRENCY), until it is stopped.

Loop: send any report an earlier outage kept back (the outbox), pick the kinds it may take now, claim one
through the API, read its context, run its handler, report `done` or `fail`, and record the job's Claude
usage in today's spend (the file edition runs use, so DAILY_BUDGET_USD caps both). Idle, it asks again
every JOBS_POLL_S seconds; when the web app does not answer it backs off (doubling, at most five minutes).

What it will not claim, so the jobs wait queued instead of failing:
- translations and fills once today's usage has reached DAILY_BUDGET_USD (until the day turns over in
  TZ), or while the Claude Code CLI is signed out (asked again every few minutes);
- jobs that read publishers' pages (translations, images) while the edition run is active
  (JOBS_PAUSE_DURING_EDITIONS), so two processes never read one host at once.

Time limit: the site cannot extend a lease (JOBS_LEASE_S), so a job still running 90 s before its lease
ends is cancelled and reported as a retryable failure; otherwise another claim could take it again and
the work (and its Claude usage) would be done twice.

Stopping: the first SIGINT or SIGTERM stops claiming and lets the current job finish, for up to
JOBS_STOP_GRACE_S; after that, or on a second signal, the job is cancelled and reported as a retryable
failure (queued again in a minute). The process then exits 0.

A result the web app could not take because it was down is written to out/state/job-outbox/ and sent
before the next claim (the lease is long, so it usually still holds). A report the site refuses for good
(400, 404, 409) is logged and dropped."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from .. import log
from ..api import ApiError, WorkerApi
from ..config import Settings
from ..fetch.http import Fetcher
from ..llm import LLM, NOT_SIGNED_IN, LLMError
from ..models import (
    FillLanguageResult,
    Job,
    JobContext,
    JobKind,
    JobResult,
    StoryImageResult,
    TranslateArticleBlockedResult,
    TranslateArticleDone,
)
from ..translate import TranslationFailed
from . import budget
from .base import BudgetReached, Done, Failed, JobEnv, JobError, Outcome, Usage
from .fill_language import handle_fill
from .fulltext import FullTextFetcher
from .story_image import handle_image
from .translate_article import handle_translate

logger = log.get("jobs")

ALL_KINDS: tuple[JobKind, ...] = ("translate_article", "fill_language", "story_image")
CLAUDE_KINDS = frozenset({"translate_article", "fill_language"})  # story_image's check fails safe without Claude
FETCH_KINDS = frozenset({"translate_article", "story_image"})
HANDLERS: dict[str, Callable[[Job, JobContext, JobEnv], Awaitable[Outcome]]] = {
    "translate_article": handle_translate,
    "fill_language": handle_fill,
    "story_image": handle_image,
}
MAX_BACKOFF_S = 300.0
BLOCKED_WAIT_S = 60.0  # nothing claimable (budget, sign-in, an edition run): look again after this
AUTH_OK_TTL_S = 1800.0
AUTH_BAD_TTL_S = 300.0
EDITION_PROBE_TTL_S = 20.0
OUTBOX = "job-outbox"
OUTBOX_MAX_AGE = timedelta(days=2)
INTERRUPT_RETRY_S = 60
LEASE_MARGIN_S = 90.0  # a job is cancelled this long before its lease runs out, to report in time


def default_worker_id() -> str:
    raw = f"{socket.gethostname()}-{os.getpid()}"
    return re.sub(r"[^A-Za-z0-9._:@-]", "-", raw)[:100]


RUNNING_STATES = frozenset({"active", "activating", "deactivating", "reloading", "refreshing"})


def unit_active(unit: str = "news-worker.service") -> bool:
    """Whether a systemd user unit is running now (False without systemd). news-worker.service is
    Type=oneshot: for the whole edition run its state is `activating`, which `systemctl is-active` does
    not count as active, so the unit's ActiveState is read instead."""
    if not shutil.which("systemctl"):
        return False
    try:
        r = subprocess.run(
            ["systemctl", "--user", "show", "--property=ActiveState", "--value", unit],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return r.stdout.strip() in RUNNING_STATES


def result_model(kind: str, data: dict[str, Any]) -> JobResult:
    """A stored result (the outbox) back as its model."""
    if kind == "translate_article":
        return (TranslateArticleBlockedResult if "blocked" in data else TranslateArticleDone).model_validate(data)
    if kind == "fill_language":
        return FillLanguageResult.model_validate(data)
    return StoryImageResult.model_validate(data)


@dataclass
class JobReport:
    id: int
    kind: str
    status: str  # done | blocked | failed | queued (retry scheduled) | lost (lease gone) | outbox (web down)
    applied: bool | None = None
    note: str = ""
    error: str = ""
    cost_usd: float = 0.0
    seconds: float = 0.0


@dataclass
class RunnerReport:
    jobs: list[JobReport] = field(default_factory=list)
    status: str = "ok"  # ok | idle (--once found nothing) | stopped | interrupted | api_error | not_claimable
    reason: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"status": self.status, "reason": self.reason, "jobs": [j.__dict__ for j in self.jobs]}


class JobRunner:
    def __init__(
        self,
        settings: Settings,
        api: WorkerApi,
        llm: LLM,
        fetcher: Fetcher,
        *,
        kinds: list[JobKind] | tuple[JobKind, ...] | None = None,
        worker_id: str | None = None,
        concurrency: int | None = None,
        fulltext: FullTextFetcher | None = None,
        edition_running: Callable[[], bool] | None = None,
    ):
        self.s = settings
        self.api = api
        self.llm = llm
        self.fetcher = fetcher
        self.kinds: tuple[JobKind, ...] = tuple(dict.fromkeys(kinds or ALL_KINDS))
        self.worker_id = worker_id or default_worker_id()
        self.concurrency = max(1, min(4, concurrency or settings.jobs_concurrency))
        # The site cannot extend a lease, so a job must end before its lease does: past that, another
        # claim could take the job again (a second worker, or a parallel loop) and the work is done twice.
        self.lease_s = max(60, min(3600, int(settings.jobs_lease_s)))
        self.job_time_limit_s = max(30.0, self.lease_s - LEASE_MARGIN_S)
        self.fulltext = fulltext or FullTextFetcher(fetcher, settings)
        self._edition_running = edition_running or unit_active
        self.report = RunnerReport()
        self.stopping = False
        self.interrupted = False
        self._wake: asyncio.Event | None = None
        self._tasks: dict[asyncio.Task, int] = {}
        self._cancelled: set[int] = set()
        self._timed_out: set[int] = set()
        self._grace: asyncio.TimerHandle | None = None
        self._auth: tuple[float, str | None] | None = None
        self._edition: tuple[float, bool] | None = None
        self._said: dict[str, str] = {}
        self._started = 0

    # ---- logging a condition once while it lasts -----------------------------------------------
    def _say(self, key: str, msg: str) -> None:
        if self._said.get(key) != msg:
            logger.warning(msg)
            self._said[key] = msg

    def _clear(self, key: str, msg: str | None = None) -> None:
        if self._said.pop(key, None) is not None and msg:
            logger.info(msg)

    # ---- what may be claimed now ----------------------------------------------------------------
    def _auth_problem(self) -> str | None:
        now = time.monotonic()
        if self._auth and now - self._auth[0] < (AUTH_BAD_TTL_S if self._auth[1] else AUTH_OK_TTL_S):
            return self._auth[1]
        status = getattr(self.llm, "auth_status", None)
        if callable(status):
            st = status()
            problem = st.get("error") or (None if st.get("logged_in") else NOT_SIGNED_IN)
        else:
            check = getattr(self.llm, "auth_problem", None)
            problem = check() if callable(check) else None
        self._auth = (now, problem)
        return problem

    def _edition_active(self) -> bool:
        now = time.monotonic()
        if self._edition and now - self._edition[0] < EDITION_PROBE_TTL_S:
            return self._edition[1]
        active = bool(self._edition_running())
        self._edition = (now, active)
        return active

    def claimable(self) -> tuple[list[JobKind], str]:
        """(kinds that may be claimed now, why the others wait)."""
        kinds = list(self.kinds)
        why: list[str] = []
        if CLAUDE_KINDS & set(kinds):
            spent = budget.spent_today(self.s)
            if spent >= self.s.daily_budget_usd:
                msg = (
                    f"daily usage ceiling reached (${spent:.2f} of ${self.s.daily_budget_usd:.2f} API-equivalent): "
                    "translations and fills wait until tomorrow"
                )
                self._say("budget", msg)
                why.append(msg)
                kinds = [k for k in kinds if k not in CLAUDE_KINDS]
            else:
                self._clear("budget", "daily usage ceiling no longer reached: translations and fills resume")
                problem = self._auth_problem()
                if problem:
                    msg = f"Claude is not available ({problem}): translations and fills wait"
                    self._say("auth", msg)
                    why.append(msg)
                    kinds = [k for k in kinds if k not in CLAUDE_KINDS]
                else:
                    self._clear("auth", "Claude is available again: translations and fills resume")
        if FETCH_KINDS & set(kinds) and self.s.jobs_pause_during_editions and self._edition_active():
            msg = "an edition run is active: jobs that read publishers' pages wait for it to finish"
            self._say("edition", msg)
            why.append(msg)
            kinds = [k for k in kinds if k not in FETCH_KINDS]
        elif FETCH_KINDS & set(self.kinds):
            self._clear("edition", "the edition run finished: all jobs resume")
        return kinds, "; ".join(why)

    # ---- signals --------------------------------------------------------------------------------
    def _on_signal(self, signame: str) -> None:
        if self.stopping:
            logger.warning("%s again: stopping now", signame)
            self.interrupt("a second stop signal")
            return
        self.stopping = True
        if self._wake:
            self._wake.set()
        if self._tasks:
            grace = self.s.jobs_stop_grace_s
            logger.warning(
                "%s: finishing the current job (up to %.0f s), then stopping; send it again to stop now", signame, grace
            )
            loop = asyncio.get_running_loop()
            self._grace = loop.call_later(grace, self.interrupt, f"the {grace:.0f} s stop grace period ran out")
        else:
            logger.info("%s: stopping", signame)

    def stop(self) -> None:
        """Stop after the current job (what the first signal does)."""
        self._on_signal("stop")

    def interrupt(self, why: str) -> None:
        """Cancel the running jobs now; each is reported as a retryable failure."""
        self.stopping = True
        if self._wake:
            self._wake.set()
        for task, job_id in list(self._tasks.items()):
            if not task.done():
                logger.warning("job %d: cancelled (%s)", job_id, why)
                self._cancelled.add(job_id)
                self.interrupted = True
                task.cancel()

    def _time_out(self, task: asyncio.Task, job_id: int) -> None:
        if not task.done():
            logger.warning("job %d: over its %.0f s time limit; cancelled", job_id, self.job_time_limit_s)
            self._timed_out.add(job_id)
            task.cancel()

    async def _pause(self, seconds: float) -> None:
        assert self._wake is not None
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), timeout=max(0.0, seconds))

    # ---- main loop ------------------------------------------------------------------------------
    async def run(
        self, *, once: bool = False, max_jobs: int | None = None, install_signals: bool = False
    ) -> RunnerReport:
        loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        installed: list[int] = []
        if install_signals:
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    loop.add_signal_handler(sig, self._on_signal, sig.name)
                    installed.append(sig)
                except (NotImplementedError, RuntimeError):  # pragma: no cover - not the main thread
                    pass
        logger.info(
            "job runner %s: kinds %s, %d at a time, lease %d s, daily ceiling $%.2f",
            self.worker_id,
            ",".join(self.kinds),
            1 if once else self.concurrency,
            self.lease_s,
            self.s.daily_budget_usd,
        )
        try:
            loops = 1 if once else self.concurrency
            await asyncio.gather(*(self._loop(once, max_jobs) for _ in range(loops)))
        finally:
            for sig in installed:
                loop.remove_signal_handler(sig)
            if self._grace:
                self._grace.cancel()
            save = getattr(self.fetcher, "save_state", None)
            if callable(save):
                save()
        if self.interrupted:
            self.report.status = "interrupted"
        elif self.stopping and self.report.status == "ok":
            self.report.status = "stopped"
        return self.report

    async def _loop(self, once: bool, max_jobs: int | None) -> None:
        backoff = 0.0
        while not self.stopping:
            if max_jobs is not None and self._started >= max_jobs:
                return
            await asyncio.to_thread(self._flush_outbox)
            # In a thread: the sign-in check runs the Claude Code CLI (up to 30 s) and the edition check
            # systemctl, which must not hold up jobs other loops are running.
            kinds, why = await asyncio.to_thread(self.claimable)
            if self.stopping:
                return
            if not kinds:
                if once:
                    self.report.status, self.report.reason = "not_claimable", why
                    return
                await self._pause(BLOCKED_WAIT_S)
                continue
            if max_jobs is not None and self._started >= max_jobs:
                return  # another loop took the last slot meanwhile
            self._started += 1  # reserved before the claim, so parallel loops never exceed --max-jobs
            try:
                job = await asyncio.to_thread(self.api.claim_job, kinds, self.worker_id, self.lease_s)
            except (ApiError, httpx.HTTPError) as e:
                self._started -= 1
                what = f"{e.status} {e.message}" if isinstance(e, ApiError) else f"{type(e).__name__}: {e}"
                backoff = min(MAX_BACKOFF_S, max(self.s.jobs_poll_s * 2, backoff * 2))
                self._say("api", f"could not claim a job ({what[:200]}); asking again in {backoff:.0f} s")
                if once:
                    self.report.status, self.report.reason = "api_error", what[:300]
                    return
                await self._pause(backoff)
                continue
            if backoff:
                self._clear("api", "the web app answers again")
            backoff = 0.0
            if job is None:
                self._started -= 1
                if once:
                    self.report.status = "idle"
                    return
                await self._pause(self.s.jobs_poll_s)
                continue
            await self._process(job)
            if once:
                return

    # ---- one job --------------------------------------------------------------------------------
    def _env(self, usage: Usage) -> JobEnv:
        def budget_ok() -> bool:
            return budget.spent_today(self.s) + usage.cost_usd < self.s.daily_budget_usd

        return JobEnv(
            settings=self.s,
            api=self.api,
            llm=self.llm,
            fetcher=self.fetcher,
            fulltext=self.fulltext,
            usage=usage,
            budget_ok=budget_ok,
        )

    async def _process(self, job: Job) -> JobReport:
        usage = Usage()
        t0 = time.monotonic()
        logger.info(
            "job %d %s claimed (attempt %d of %d): %s", job.id, job.kind, job.attempts, job.max_attempts, job.payload
        )
        task = asyncio.create_task(self._handle(job, self._env(usage)))
        self._tasks[task] = job.id
        loop = asyncio.get_running_loop()
        limit = loop.call_later(self.job_time_limit_s, self._time_out, task, job.id)
        if self.stopping and self._grace is None:
            # A stop signal came while this job was being claimed: it gets the same grace period.
            grace = self.s.jobs_stop_grace_s
            self._grace = loop.call_later(grace, self.interrupt, f"the {grace:.0f} s stop grace period ran out")
        try:
            outcome = await task
        except asyncio.CancelledError:
            if job.id in self._timed_out:
                why = (
                    f"the job took longer than {self.job_time_limit_s:.0f} s and was stopped before its "
                    f"{self.lease_s} s lease ran out"
                )
                outcome = Failed(why, retry=True)
            elif job.id in self._cancelled:
                why = "interrupted: the job runner stopped before the job finished"
                outcome = Failed(why, retry=True, retry_after_s=INTERRUPT_RETRY_S)
            else:
                raise
        finally:
            limit.cancel()
            self._tasks.pop(task, None)
            if usage.cost_usd:
                total = budget.add_spend(self.s, usage.cost_usd)
                logger.info("job %d used $%.4f API-equivalent (today: $%.2f)", job.id, usage.cost_usd, total)
        report = await asyncio.to_thread(self._send, job, outcome)
        report.cost_usd = round(usage.cost_usd, 6)
        report.seconds = round(time.monotonic() - t0, 1)
        self.report.jobs.append(report)
        logger.info(
            "job %d %s: %s in %.0f s%s%s",
            job.id,
            job.kind,
            report.status,
            report.seconds,
            f": {report.note}" if report.note else "",
            f" ({report.error})" if report.error else "",
        )
        return report

    async def _handle(self, job: Job, env: JobEnv) -> Outcome:
        handler = HANDLERS.get(job.kind)
        if handler is None:
            return Failed(f"this worker cannot do {job.kind!r} jobs", retry=False)
        try:
            ctx = await asyncio.to_thread(self.api.job_context, job.id)
        except ApiError as e:
            return Failed(f"could not read the job's context: {e.status} {e.message}"[:4000], retry=e.status >= 500)
        except httpx.HTTPError as e:
            return Failed(f"could not read the job's context: {type(e).__name__}: {e}"[:4000], retry=True)
        try:
            return await handler(job, ctx, env)
        except BudgetReached as e:
            return Failed(str(e), retry=True, retry_after_s=e.retry_after_s or budget.seconds_to_midnight(self.s))
        except JobError as e:
            return Failed(str(e), retry=e.retry, retry_after_s=e.retry_after_s)
        except TranslationFailed as e:
            return Failed(str(e), retry=True)
        except LLMError as e:
            return Failed(f"a Claude call failed: {e}"[:4000], retry=True)
        except ApiError as e:
            return Failed(f"web API error {e.status}: {e.message}"[:4000], retry=e.status >= 500)
        except httpx.HTTPError as e:
            return Failed(f"web API unreachable: {type(e).__name__}: {e}"[:4000], retry=True)
        except Exception as e:  # noqa: BLE001 - a bug or an odd page: the job fails, the runner goes on
            logger.exception("job %d %s crashed", job.id, job.kind)
            return Failed(f"{type(e).__name__}: {str(e)[:500]}", retry=True)

    # ---- reporting ------------------------------------------------------------------------------
    def _send(self, job: Job, outcome: Outcome) -> JobReport:
        rep = JobReport(id=job.id, kind=job.kind, status="failed")
        if isinstance(outcome, Done):
            rep.note = outcome.summary
            try:
                out = self.api.job_done(job.id, outcome.result, worker_id=self.worker_id)
            except ApiError as e:
                if e.status == 400:
                    detail = f"{e.message} {json.dumps(e.issues)[:600] if e.issues else ''}".strip()
                    logger.error("job %d: the site refused the result: %s", job.id, detail)
                    return self._fail(job, Failed(f"result refused by the site: {detail}"[:4000], retry=False), rep)
                if e.status in (404, 409):
                    rep.status, rep.error = "lost", f"{e.status} {e.message}"
                    logger.warning("job %d: result not taken (%s)", job.id, rep.error)
                    return rep
                self._keep(job, "done", {"result": outcome.result.model_dump(mode="json")})
                rep.status, rep.error = "outbox", f"{e.status} {e.message}"
                return rep
            except httpx.HTTPError as e:
                self._keep(job, "done", {"result": outcome.result.model_dump(mode="json")})
                rep.status, rep.error = "outbox", f"{type(e).__name__}: {e}"
                return rep
            rep.status, rep.applied = out.status, out.applied
            if not out.applied:
                rep.error = f"not applied: {out.note or ''}"
            elif out.note:
                rep.note = f"{rep.note}; site: {out.note}" if rep.note else f"site: {out.note}"
            return rep
        return self._fail(job, outcome, rep)

    def _fail(self, job: Job, f: Failed, rep: JobReport) -> JobReport:
        rep.error = f.error[:500]
        wait = f.retry_after_s
        body = {
            "error": " ".join(f.error.split())[:4000] or "failed",
            "retry": f.retry and not f.blocked,
            "blocked": f.blocked,
            "reason": f.reason,
            # The site takes 0 to a day (a publisher's Retry-After can say more).
            "retry_after_s": None if wait is None else max(0, min(86_400, int(wait))),
        }
        try:
            out = self.api.job_fail(job.id, **{**body, "worker_id": self.worker_id})
        except ApiError as e:
            if e.status < 500:
                rep.status = "lost"
                logger.warning("job %d: failure report not taken (%s %s)", job.id, e.status, e.message)
                return rep
            self._keep(job, "fail", body)
            rep.status = "outbox"
            return rep
        except httpx.HTTPError:
            self._keep(job, "fail", body)
            rep.status = "outbox"
            return rep
        rep.status = out.status
        if out.retry_at:
            rep.note = f"tried again after {out.retry_at:%H:%M:%S} UTC"
        return rep

    # ---- the outbox -----------------------------------------------------------------------------
    @property
    def _outbox(self) -> Path:
        return self.s.state_dir / OUTBOX

    def _keep(self, job: Job, op: str, body: dict[str, Any]) -> None:
        entry = {
            "op": op,
            "job_id": job.id,
            "kind": job.kind,
            "worker_id": self.worker_id,
            "saved_at": datetime.now(UTC).isoformat(),
            **body,
        }
        try:
            self._outbox.mkdir(parents=True, exist_ok=True)
            path = self._outbox / f"{job.id}.json"
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(entry, ensure_ascii=False))
            os.replace(tmp, path)
            logger.warning("job %d: the web app did not take the report; kept in %s to send later", job.id, path)
        except OSError as e:
            logger.error("job %d: could not keep the report (%s); it is lost", job.id, e)

    def _flush_outbox(self) -> None:
        try:
            files = sorted(self._outbox.glob("*.json"))
        except OSError:
            return
        for path in files:
            try:
                entry = json.loads(path.read_text())
                saved = datetime.fromisoformat(entry["saved_at"])
                job_id, wid = int(entry["job_id"]), entry.get("worker_id") or None
            except (OSError, ValueError, KeyError, TypeError):
                path.unlink(missing_ok=True)
                continue
            if datetime.now(UTC) - saved > OUTBOX_MAX_AGE:
                logger.warning("job %d: dropping a report kept since %s", job_id, entry["saved_at"])
                path.unlink(missing_ok=True)
                continue
            try:
                if entry["op"] == "done":
                    self.api.job_done(job_id, result_model(entry["kind"], entry["result"]), worker_id=wid)
                else:
                    self.api.job_fail(
                        job_id,
                        entry["error"],
                        retry=bool(entry.get("retry")),
                        blocked=bool(entry.get("blocked")),
                        reason=entry.get("reason"),
                        retry_after_s=entry.get("retry_after_s"),
                        worker_id=wid,
                    )
            except ApiError as e:
                if e.status >= 500:
                    return  # still down: keep it, try again next time
                logger.warning("job %d: kept report refused (%s %s); dropped", job_id, e.status, e.message)
            except httpx.HTTPError:
                return
            except (ValueError, KeyError) as e:
                logger.warning("job %d: kept report unreadable (%s); dropped", job_id, e)
            else:
                logger.info("job %d: kept report delivered", job_id)
            path.unlink(missing_ok=True)
