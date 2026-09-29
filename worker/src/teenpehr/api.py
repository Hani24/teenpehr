"""HTTP client for the web app's worker API (docs/API.md). Retries transport errors and 5xx with
backoff; a 4xx is a programming or data error and is raised as ApiError immediately. POST /runs is
the one call the server does not deduplicate, so it is replayed only when the request never left."""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

import httpx

from . import log
from .models import (
    Config,
    EditionIn,
    EditionOut,
    EditionState,
    ImageIn,
    ImageOut,
    ItemIn,
    ItemOut,
    ItemRecord,
    Job,
    JobContext,
    JobDoneOut,
    JobFailOut,
    JobKind,
    JobResult,
    PostIn,
    PostOut,
    PostRecord,
    PublishOut,
    RunFinish,
    RunOutputIn,
)

logger = log.get("api")


class ApiError(RuntimeError):
    def __init__(self, status: int, message: str, issues: Any = None):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message
        self.issues = issues


def _jsonable(model) -> dict[str, Any]:
    return model.model_dump(mode="json", exclude_none=False)


def _sparse(model) -> dict[str, Any]:
    """Items and posts leave out what they do not know: the server keeps an absent field as stored,
    and several of its metadata fields accept a value or nothing, never null."""
    return model.model_dump(mode="json", exclude_none=True)


# Transport errors raised before the request reached the server, so a replay cannot repeat it.
_NOT_SENT = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)


def unknown_sources(e: ApiError) -> set[int]:
    """Source ids a 400 names in `issues.sources`: removed in the admin since the run read its config.
    The server stores nothing from such a request, so the caller drops them and sends it again."""
    issues = e.issues if e.status == 400 and isinstance(e.issues, dict) else {}
    ids = issues.get("sources")
    return {i for i in ids if isinstance(i, int)} if isinstance(ids, list) else set()


class WorkerApi:
    def __init__(self, site_url: str, token: str, *, timeout: float = 60.0, retries: int = 3, backoff: float = 1.0):
        self.base = site_url.rstrip("/")
        self.retries = retries
        self.backoff = backoff
        self._client = httpx.Client(
            base_url=self.base,
            headers={"Authorization": f"Bearer {token}", "User-Agent": "teenpehr-worker/0.1"},
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    # ---- transport ----------------------------------------------------------------------------
    def _request(
        self, method: str, path: str, *, json: Any = None, params: dict[str, Any] | None = None, replay: bool = True
    ) -> Any:
        """`replay=False` for a call the server does not deduplicate: after a read timeout or a dropped
        connection it may have acted already, and a second attempt would do it twice."""
        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                r = self._client.request(method, path, json=json, params=params)
            except httpx.TransportError as e:
                last = e
                logger.warning("%s %s transport error (attempt %d): %s", method, path, attempt, e)
                if not replay and not isinstance(e, _NOT_SENT):
                    raise
            else:
                if r.status_code >= 500:
                    last = ApiError(r.status_code, r.text[:300])
                    logger.warning("%s %s -> %d (attempt %d)", method, path, r.status_code, attempt)
                elif r.status_code >= 400:
                    try:
                        body = r.json()
                    except ValueError:
                        body = {"error": r.text[:300]}
                    raise ApiError(r.status_code, str(body.get("error", body)), body.get("issues"))
                else:
                    return r.json() if r.content else {}
            time.sleep(self.backoff * (2 ** (attempt - 1)))
        assert last is not None
        raise last

    # ---- routes -------------------------------------------------------------------------------
    def health(self) -> dict[str, Any]:
        return self._request("GET", "/api/worker/health")

    def config(self) -> Config:
        return Config.model_validate(self._request("GET", "/api/worker/config"))

    def start_run(self, kind: str, date: str | None = None, slot: str | None = None) -> int:
        body: dict[str, Any] = {"kind": kind}
        if date:
            body["date"] = date
        if slot:
            body["slot"] = slot
        # Each POST inserts a run row, so a replay after a timeout would leave an orphan "running" one.
        return int(self._request("POST", "/api/worker/runs", json=body, replay=False)["id"])

    def finish_run(self, run_id: int, result: RunFinish) -> None:
        """Idempotent on the server, so retrying is safe. Per-source results for sources that no
        longer exist are dropped and the rest sent again, so the run is still recorded."""
        for _ in range(3):
            try:
                self._request("PATCH", f"/api/worker/runs/{run_id}", json=_jsonable(result))
                return
            except ApiError as e:
                gone = unknown_sources(e)
                if not gone:
                    raise
                logger.warning("run %d: sources %s no longer exist; recording it without them", run_id, sorted(gone))
                kept = [r for r in result.sources if r.source_id not in gone]
                result = result.model_copy(update={"sources": kept})
        self._request("PATCH", f"/api/worker/runs/{run_id}", json=_jsonable(result))

    def post_items(self, run_id: int | None, items: list[ItemIn], chunk: int = 500) -> list[ItemOut]:
        """Items of a source removed in the admin since the run read its config are dropped (the
        server refuses the whole request over them), so they get no id and the run skips them."""
        out: list[ItemOut] = []
        for i in range(0, len(items), chunk):
            batch = items[i : i + chunk]
            for _ in range(3):
                try:
                    body = {"run_id": run_id, "items": [_sparse(x) for x in batch]}
                    res = self._request("POST", "/api/worker/items", json=body)
                    break
                except ApiError as e:
                    gone = unknown_sources(e)
                    if not gone:
                        raise
                    logger.warning("sources %s no longer exist; their items are left out", sorted(gone))
                    batch = [x for x in batch if x.source_id not in gone]
                    if not batch:
                        res = {}
                        break
            else:
                raise ApiError(400, "items kept naming unknown sources")
            out.extend(ItemOut.model_validate(x) for x in res.get("items", []))
        return out

    def post_posts(self, run_id: int | None, posts: list[PostIn], chunk: int = 500) -> list[PostOut]:
        out: list[PostOut] = []
        for i in range(0, len(posts), chunk):
            body = {"run_id": run_id, "posts": [_sparse(x) for x in posts[i : i + chunk]]}
            res = self._request("POST", "/api/worker/posts", json=body)
            out.extend(PostOut.model_validate(x) for x in res.get("posts", []))
        return out

    def post_run_outputs(self, run_id: int, outputs: list[RunOutputIn], chunk: int = 100) -> list[int]:
        """Each Claude call's structured output, kept for audits. The server does not deduplicate these,
        so like POST /runs a request is replayed only when it never reached the server."""
        ids: list[int] = []
        for i in range(0, len(outputs), chunk):
            body = {"outputs": [_jsonable(o) for o in outputs[i : i + chunk]]}
            res = self._request("POST", f"/api/worker/runs/{run_id}/outputs", json=body, replay=False)
            ids.extend(int(x) for x in res.get("ids", []))
        return ids

    def get_posts(self, since: datetime, group: str | None = None, handle: str | None = None) -> list[PostRecord]:
        params: dict[str, Any] = {"since": since.isoformat()}
        if group:
            params["group"] = group
        if handle:
            params["handle"] = handle
        res = self._request("GET", "/api/worker/posts", params=params)
        return [PostRecord.model_validate(x) for x in res.get("posts", [])]

    def get_items(self, since: datetime, group: str | None = None) -> list[ItemRecord]:
        params: dict[str, Any] = {"since": since.isoformat()}
        if group:
            params["group"] = group
        res = self._request("GET", "/api/worker/items", params=params)
        return [ItemRecord.model_validate(x) for x in res.get("items", [])]

    def get_edition(self, date: str, slot: str) -> EditionState | None:
        """The edition's current state, or None when it does not exist yet. A 405 means a web app
        older than this route; that is treated as unknown (with a warning) rather than failing the run."""
        try:
            res = self._request("GET", f"/api/worker/editions/{date}/{slot}")
        except ApiError as e:
            if e.status == 404:
                return None
            if e.status == 405:
                logger.warning("the web app has no GET /editions/{date}/{slot} yet; rebuild it to enable the check")
                return None
            raise
        return EditionState.model_validate(res)

    def put_edition(self, date: str, slot: str, edition: EditionIn) -> EditionOut:
        res = self._request("PUT", f"/api/worker/editions/{date}/{slot}", json=_jsonable(edition))
        return EditionOut.model_validate(res)

    def publish(self, date: str, slot: str, *, force: bool = False, notify: bool = True) -> PublishOut:
        res = self._request(
            "POST", f"/api/worker/editions/{date}/{slot}/publish", json={"force": force, "notify": notify}
        )
        return PublishOut.model_validate(res)

    def post_image(self, image: ImageIn) -> ImageOut:
        """Upload one publisher image (D6). Idempotent per (sha256, item or post) on the server, so a
        retry is safe: a repeat answers 200 with the first row's id. A 400 or 413 raises ApiError."""
        return ImageOut.model_validate(self._request("POST", "/api/worker/images", json=_jsonable(image)))

    def add_glossary(self, entries: list[dict[str, str]]) -> dict[str, Any]:
        if not entries:
            return {"added": 0, "skipped": 0}
        return self._request("POST", "/api/worker/glossary", json={"entries": entries})

    def handle_seen(self, handle_id: int, last_post_at: datetime | None, fallback_used: bool = False) -> None:
        body: dict[str, Any] = {"fallback_used": fallback_used}
        if last_post_at:
            body["last_post_at"] = last_post_at.isoformat()
        self._request("POST", f"/api/worker/handles/{handle_id}/seen", json=body)

    # ---- jobs (docs/API.md § Jobs) ------------------------------------------------------------
    def claim_job(self, kinds: list[JobKind], worker_id: str, lease_s: int = 600) -> Job | None:
        """The next job of one of `kinds`, leased to `worker_id` for `lease_s` seconds, or None. Each claim
        counts an attempt; not replayed after a read timeout (a lost answer would leave the job leased until
        its lease runs out, after which it is claimable again)."""
        body = {"kinds": list(kinds), "worker_id": worker_id, "lease_s": lease_s}
        res = self._request("POST", "/api/worker/jobs/claim", json=body, replay=False)
        job = res.get("job")
        return Job.model_validate(job) if job else None

    def job_context(self, job_id: int) -> JobContext:
        return JobContext.model_validate(self._request("GET", f"/api/worker/jobs/{job_id}/context"))

    def job_done(self, job_id: int, result: JobResult, worker_id: str | None = None) -> JobDoneOut:
        """Report a result. Idempotent: a repeat for a job already done answers `already`."""
        body: dict[str, Any] = {"result": result.model_dump(mode="json")}
        if worker_id:
            body["worker_id"] = worker_id
        return JobDoneOut.model_validate(self._request("POST", f"/api/worker/jobs/{job_id}/done", json=body))

    def job_fail(
        self,
        job_id: int,
        error: str,
        *,
        retry: bool = False,
        blocked: bool = False,
        reason: str | None = None,
        retry_after_s: int | None = None,
        worker_id: str | None = None,
    ) -> JobFailOut:
        """Report a failure. `retry`: queue it again (backoff) while attempts remain. `blocked`: final, the work
        cannot be done legitimately (for a translation, `reason` is one of TranslationBlockReason)."""
        body: dict[str, Any] = {"error": error[:4000] or "failed", "retry": retry, "blocked": blocked}
        if reason:
            body["reason"] = reason
        if retry_after_s is not None:
            body["retry_after_s"] = retry_after_s
        if worker_id:
            body["worker_id"] = worker_id
        return JobFailOut.model_validate(self._request("POST", f"/api/worker/jobs/{job_id}/fail", json=body))
