"""HTTP client for the web app's worker API (docs/API.md). Retries transport errors and 5xx with
backoff; a 4xx is a programming or data error and is raised as ApiError immediately."""

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
    ItemIn,
    ItemOut,
    ItemRecord,
    PostIn,
    PostOut,
    PostRecord,
    PublishOut,
    RunFinish,
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
    def _request(self, method: str, path: str, *, json: Any = None, params: dict[str, Any] | None = None) -> Any:
        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                r = self._client.request(method, path, json=json, params=params)
            except httpx.TransportError as e:
                last = e
                logger.warning("%s %s transport error (attempt %d): %s", method, path, attempt, e)
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
        return int(self._request("POST", "/api/worker/runs", json=body)["id"])

    def finish_run(self, run_id: int, result: RunFinish) -> None:
        self._request("PATCH", f"/api/worker/runs/{run_id}", json=_jsonable(result))

    def post_items(self, run_id: int | None, items: list[ItemIn], chunk: int = 500) -> list[ItemOut]:
        out: list[ItemOut] = []
        for i in range(0, len(items), chunk):
            body = {"run_id": run_id, "items": [_jsonable(x) for x in items[i : i + chunk]]}
            res = self._request("POST", "/api/worker/items", json=body)
            out.extend(ItemOut.model_validate(x) for x in res.get("items", []))
        return out

    def post_posts(self, run_id: int | None, posts: list[PostIn], chunk: int = 500) -> list[PostOut]:
        out: list[PostOut] = []
        for i in range(0, len(posts), chunk):
            body = {"run_id": run_id, "posts": [_jsonable(x) for x in posts[i : i + chunk]]}
            res = self._request("POST", "/api/worker/posts", json=body)
            out.extend(PostOut.model_validate(x) for x in res.get("posts", []))
        return out

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

    def put_edition(self, date: str, slot: str, edition: EditionIn) -> EditionOut:
        res = self._request("PUT", f"/api/worker/editions/{date}/{slot}", json=_jsonable(edition))
        return EditionOut.model_validate(res)

    def publish(self, date: str, slot: str, *, force: bool = False, notify: bool = True) -> PublishOut:
        res = self._request(
            "POST", f"/api/worker/editions/{date}/{slot}/publish", json={"force": force, "notify": notify}
        )
        return PublishOut.model_validate(res)

    def add_glossary(self, entries: list[dict[str, str]]) -> dict[str, Any]:
        if not entries:
            return {"added": 0, "skipped": 0}
        return self._request("POST", "/api/worker/glossary", json={"entries": entries})

    def handle_seen(self, handle_id: int, last_post_at: datetime | None, fallback_used: bool = False) -> None:
        body: dict[str, Any] = {"fallback_used": fallback_used}
        if last_post_at:
            body["last_post_at"] = last_post_at.isoformat()
        self._request("POST", f"/api/worker/handles/{handle_id}/seen", json=body)
