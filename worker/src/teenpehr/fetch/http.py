"""Tier-1 HTTP fetcher: curl_cffi with a Chrome TLS/HTTP2 fingerprint, one request per host at a
time, conditional requests, and a per-request route (direct or through the Germany SOCKS proxy).

A direct fetch that fails twice with a DNS or connection-level error is retried once through
Germany when the caller allows it; the result reports which route actually served the bytes."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from curl_cffi import CurlECode, CurlError
from curl_cffi import requests as creq

from .. import log
from ..config import Settings

logger = log.get("fetch.http")

# What a real browser sends on a top-level navigation; sites such as Mondoweiss 403 without it.
NAV_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,ur;q=0.8",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

# libcurl codes that mean "this host is unreachable from here" rather than "the site said no"
_BLOCKED_CODES = {
    int(CurlECode.COULDNT_RESOLVE_HOST),
    int(CurlECode.COULDNT_CONNECT),
    int(CurlECode.SSL_CONNECT_ERROR),
    int(CurlECode.RECV_ERROR),
    int(CurlECode.SEND_ERROR),
}


@dataclass
class FetchResult:
    url: str
    status: int
    content: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)
    final_url: str = ""
    route_used: str = "direct"
    fell_back: bool = False
    ms: int = 0
    error: str | None = None
    not_modified: bool = False
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.error is None and 200 <= self.status < 300


class Fetcher:
    """Thread-safe. One curl session per route; requests to the same host are serialised."""

    def __init__(self, settings: Settings, *, state_file: Path | None = None):
        self.s = settings
        self._sessions = {
            "direct": creq.Session(impersonate="chrome", timeout=settings.fetch_timeout_s),
            "germany": creq.Session(
                impersonate="chrome",
                timeout=settings.fetch_timeout_s,
                proxies={"http": settings.germany_proxy, "https": settings.germany_proxy},
            ),
        }
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._state_file = state_file or (settings.state_dir / "http-cache.json")
        self._state: dict[str, dict[str, str]] = self._load_state()
        self._state_lock = threading.Lock()

    # ---- state (Last-Modified / ETag per URL) --------------------------------------------------
    def _load_state(self) -> dict[str, dict[str, str]]:
        try:
            return json.loads(self._state_file.read_text())
        except (OSError, ValueError):
            return {}

    def save_state(self) -> None:
        with self._state_lock:
            try:
                self._state_file.parent.mkdir(parents=True, exist_ok=True)
                self._state_file.write_text(json.dumps(self._state))
            except OSError as e:
                logger.warning("could not save http state: %s", e)

    def _lock_for(self, url: str) -> threading.Lock:
        host = (urlsplit(url).hostname or "").lower()
        with self._locks_guard:
            return self._locks.setdefault(host, threading.Lock())

    # ---- fetch --------------------------------------------------------------------------------
    def get(
        self,
        url: str,
        *,
        route: str = "direct",
        headers: dict[str, str] | None = None,
        conditional: bool = False,
        allow_fallback: bool = True,
        max_bytes: int = 5_000_000,
    ) -> FetchResult:
        # The impersonation profile owns the User-Agent (and client hints); overriding it produces an
        # inconsistent client that WAFs score as a bot (Mondoweiss went from 403 to 200 on this alone).
        hdrs = dict(NAV_HEADERS)
        if headers:
            hdrs.update({k: v for k, v in headers.items() if k.lower() != "user-agent"})
        if conditional:
            with self._state_lock:
                prev = self._state.get(url, {})
            if prev.get("etag"):
                hdrs["If-None-Match"] = prev["etag"]
            if prev.get("last_modified"):
                hdrs["If-Modified-Since"] = prev["last_modified"]

        with self._lock_for(url):
            result = self._attempt(url, route, hdrs, max_bytes)
            if result.error and result.status == 0 and route == "direct":
                # second try on the same route before deciding the host is blocked
                result = self._attempt(url, route, hdrs, max_bytes)
                if result.error and result.status == 0 and allow_fallback and getattr(result, "_blocked", False):
                    logger.info("%s unreachable directly (%s); trying Germany", url, result.error)
                    result = self._attempt(url, "germany", hdrs, max_bytes)
                    result.fell_back = True
        if result.ok and conditional:
            with self._state_lock:
                self._state[url] = {
                    "etag": result.headers.get("etag", ""),
                    "last_modified": result.headers.get("last-modified", ""),
                }
        return result

    def _attempt(self, url: str, route: str, hdrs: dict[str, str], max_bytes: int) -> FetchResult:
        t0 = time.monotonic()
        res = FetchResult(url=url, status=0, route_used=route)
        try:
            r = self._sessions[route].get(url, headers=hdrs, allow_redirects=True, max_recv_speed=0)
            res.status = r.status_code
            res.final_url = str(r.url)
            res.headers = {k.lower(): v for k, v in r.headers.items()}
            if r.status_code == 304:
                res.not_modified = True
            elif 200 <= r.status_code < 300:
                res.content = r.content[:max_bytes]
            else:
                res.error = f"http {r.status_code}"
        except creq.exceptions.RequestException as e:
            code = getattr(e, "code", None)
            if code is None and isinstance(e.__cause__, CurlError):
                code = e.__cause__.code
            res.error = f"{type(e).__name__}: {str(e)[:160]}"
            res._blocked = int(code) in _BLOCKED_CODES if code is not None else False  # type: ignore[attr-defined]
            res.timed_out = isinstance(e, creq.exceptions.Timeout) or code == int(CurlECode.OPERATION_TIMEDOUT)
        except CurlError as e:
            res.error = f"CurlError {e.code}: {str(e)[:160]}"
            res._blocked = int(e.code) in _BLOCKED_CODES  # type: ignore[attr-defined]
            res.timed_out = e.code == int(CurlECode.OPERATION_TIMEDOUT)
        res.ms = int((time.monotonic() - t0) * 1000)
        return res
