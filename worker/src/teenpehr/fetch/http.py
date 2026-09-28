"""Tier-1 HTTP fetcher: curl_cffi with a Chrome TLS/HTTP2 fingerprint, one request per host at a
time, conditional requests, and a per-request route (direct or through the Germany SOCKS proxy).

A direct fetch that fails twice with a DNS or connection-level error is retried once through
Germany when the caller allows it; the result reports which route actually served the bytes.

A 429 puts the host on cooldown for its Retry-After (15 minutes when it sends none). Until then
every request to that host, on either route, is answered locally with `rate_limited=True` and
never leaves the machine. Cooldowns are written to the state directory, so the next run (and the
other timer's process) honours them too.

Public internet only. The URLs come from feeds and pages we do not control (an article link, a
redirect), so every request, and every redirect hop, which is followed here rather than by curl,
must go to a public address: never loopback, the LAN, link-local (cloud metadata) or another
reserved range. Direct: the host is resolved here, every address checked, and curl is pinned to
those addresses (CURLOPT_RESOLVE), so the name cannot resolve differently for the connection.
Germany: the SOCKS proxy resolves names on the far side (socks5h), so IP literals and local-only
names are refused and a name that resolves here to a non-public address is refused too; a name
that does not resolve here is left to the proxy. A refusal is `refused=True` and never falls back
to the other route."""

from __future__ import annotations

import email.utils
import ipaddress
import json
import os
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from curl_cffi import CurlECode, CurlError, CurlOpt
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
# ...and on a same-origin script POST (Google News' batchexecute), with Origin added per request.
XHR_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9,ur;q=0.8",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}

DEFAULT_COOLDOWN_S = 900.0  # a 429 without Retry-After: sit out one common rate-limit window
MAX_COOLDOWN_S = 24 * 3600.0  # a larger Retry-After is read as this, so a bogus header cannot park a host forever

# libcurl codes that mean "this host is unreachable from here" rather than "the site said no"
_BLOCKED_CODES = {
    int(CurlECode.COULDNT_RESOLVE_HOST),
    int(CurlECode.COULDNT_CONNECT),
    int(CurlECode.SSL_CONNECT_ERROR),
    int(CurlECode.RECV_ERROR),
    int(CurlECode.SEND_ERROR),
}

MAX_REDIRECTS = 10  # followed here, one checked hop at a time (curl's own following is off)
_REDIRECTS = {301, 302, 303, 307, 308}

# ---- public addresses only ----------------------------------------------------------------------
# Resolver, a module attribute so tests can answer for their made-up hosts without the network.
_getaddrinfo = socket.getaddrinfo

# Ranges `is_global` lets through but that are not somewhere a news site lives, or that embed an
# IPv4 address a gateway would reach for us (NAT64).
_EXTRA_BLOCKED = tuple(
    ipaddress.ip_network(n) for n in ("224.0.0.0/4", "64:ff9b::/96", "64:ff9b:1::/48", "fec0::/10", "ff00::/8")
)
# Names only a local resolver knows: never a publisher.
_LOCAL_NAME = re.compile(r"(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|private|home\.arpa)$")


class NotPublic(Exception):
    """The URL's host is, or resolves to, an address that is not on the public internet."""


class _Unresolved(Exception):
    """The host did not resolve here (for the direct route: unreachable, so Germany may be tried)."""


def is_public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Whether an address is on the public internet. IPv6 forms that carry an IPv4 address (mapped,
    6to4, Teredo) are judged by that address, and must pass as IPv6 too."""
    if isinstance(ip, ipaddress.IPv6Address):
        for inner in (ip.ipv4_mapped, ip.sixtofour, ip.teredo[1] if ip.teredo else None):
            if inner is not None and not is_public_ip(inner):
                return False
    return ip.is_global and not ip.is_multicast and not any(ip in n for n in _EXTRA_BLOCKED if n.version == ip.version)


def _literal_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return None


def public_addresses(url: str, *, need_resolution: bool = True) -> tuple[str, int, list[str]]:
    """(host, port, addresses) for an http(s) URL whose host is on the public internet. Raises
    NotPublic for another scheme, an IP literal or local-only name, or a name that resolves to any
    non-public address; _Unresolved when the name does not resolve (only with need_resolution; else
    the addresses are empty)."""
    p = urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise NotPublic(f"not an http(s) URL: {url[:80]}")
    host = p.hostname.rstrip(".").lower()
    try:
        port = p.port or (443 if p.scheme == "https" else 80)
    except ValueError as e:
        raise NotPublic(f"bad port in {url[:80]}") from e
    lit = _literal_ip(host)
    if lit is not None:
        if not is_public_ip(lit):
            raise NotPublic(f"{host} is not a public address")
        return host, port, [str(lit)]
    if "." not in host or _LOCAL_NAME.search(host):
        raise NotPublic(f"{host} is a local name")
    try:
        infos = _getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError) as e:
        if need_resolution:
            raise _Unresolved(f"could not resolve {host}: {e}") from e
        return host, port, []
    addrs = list(dict.fromkeys(str(i[4][0]) for i in infos))
    for a in addrs:
        ip = _literal_ip(a)
        if ip is None or not is_public_ip(ip):
            raise NotPublic(f"{host} resolves to a non-public address")
    if not addrs and need_resolution:
        raise _Unresolved(f"could not resolve {host}")
    return host, port, addrs


class _PerThreadCurlOptions(dict):
    """A Session's `curl_options` holding the calling thread's own options for its next request.
    curl_cffi applies `curl_options` to the calling thread's curl handle on every request, so one
    thread's pinned addresses never reach another thread's request on the shared Session. Tested in
    test_fetch_guard.py: a pinned request must reach a name no resolver knows."""

    def __init__(self) -> None:
        super().__init__()
        self._tl = threading.local()

    def set(self, opts: dict[Any, Any]) -> None:
        self._tl.opts = opts

    def _cur(self) -> dict[Any, Any]:
        return getattr(self._tl, "opts", None) or {}

    def items(self):  # type: ignore[override]
        return self._cur().items()

    def keys(self):  # type: ignore[override]
        return self._cur().keys()

    def __iter__(self):
        return iter(self._cur())

    def __len__(self) -> int:
        return len(self._cur())

    def __bool__(self) -> bool:
        return bool(self._cur())

    def __getitem__(self, k: Any) -> Any:
        return self._cur()[k]

    def __contains__(self, k: object) -> bool:
        return k in self._cur()


# One lock per host for the whole process, so every Fetcher (and the Google News decoder's
# fallback client) keeps to one request per host at a time.
_HOST_LOCKS: dict[str, threading.Lock] = {}
_HOST_LOCKS_GUARD = threading.Lock()


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def host_lock(host: str) -> threading.Lock:
    """The process-wide lock for `host` (a bare hostname; use host_of() on a URL)."""
    with _HOST_LOCKS_GUARD:
        return _HOST_LOCKS.setdefault(host.lower(), threading.Lock())


def parse_retry_after(value: str | None, *, now: float | None = None) -> float | None:
    """Seconds to wait from a Retry-After header (delta-seconds or an HTTP date); None when absent
    or unreadable."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, when.timestamp() - (time.time() if now is None else now))


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
    blocked: bool = False  # DNS/connect-level failure: the host looks unreachable on this route
    refused: bool = False  # not sent: the URL (or a redirect) points at a non-public address
    rate_limited: bool = False  # a 429, or skipped locally because the host is still cooling down
    retry_after_s: float | None = None
    too_large: bool = False  # hard_limit: the body is over max_bytes, so nothing was kept

    @property
    def ok(self) -> bool:
        return self.error is None and 200 <= self.status < 300


class Fetcher:
    """Thread-safe. One curl session per route; requests to the same host are serialised, and a
    host that answered 429 is left alone until its cooldown ends."""

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
        # per-request curl options (the direct route's pinned addresses), see _PerThreadCurlOptions
        self._curl_opts = {route: _PerThreadCurlOptions() for route in self._sessions}
        for route, sess in self._sessions.items():
            sess.curl_options = self._curl_opts[route]
        self._state_file = state_file or (settings.state_dir / "http-cache.json")
        self._state: dict[str, dict[str, str]] = self._load_state()
        self._state_lock = threading.Lock()
        # Next to the cache file, so `check-sources` (own cache file, same directory) shares it.
        self._cooldown_file = self._state_file.with_name("host-cooldown.json")
        self._cooldown_lock = threading.Lock()
        self._cooldowns: dict[str, float] = self._read_cooldowns()

    # ---- state (Last-Modified / ETag per URL) --------------------------------------------------
    def _load_state(self) -> dict[str, dict[str, str]]:
        try:
            return json.loads(self._state_file.read_text())
        except (OSError, ValueError):
            return {}

    def forget(self, url: str) -> None:
        """Drop the validators a conditional GET just recorded for `url`. For a body the caller could
        not use (an unparseable feed): saved, they would make the next run's 304 hide items that
        were never stored."""
        with self._state_lock:
            self._state.pop(url, None)

    def save_state(self) -> None:
        with self._state_lock:
            try:
                self._state_file.parent.mkdir(parents=True, exist_ok=True)
                self._state_file.write_text(json.dumps(self._state))
            except OSError as e:
                logger.warning("could not save http state: %s", e)

    # ---- 429 cooldowns (host -> wall-clock end, shared through a small file) --------------------
    def _read_cooldowns(self) -> dict[str, float]:
        try:
            raw = json.loads(self._cooldown_file.read_text())
        except (OSError, ValueError):
            return {}
        now = time.time()
        if not isinstance(raw, dict):
            return {}
        return {str(h): float(t) for h, t in raw.items() if isinstance(t, int | float) and t > now}

    def cooldown_left(self, url: str) -> float:
        """Seconds until requests to this URL's host may go out again (0 when they may now)."""
        host = host_of(url)
        with self._cooldown_lock:
            until = self._cooldowns.get(host, 0.0)
        return max(0.0, until - time.time())

    def cool_down(self, url: str, retry_after: float | None = None) -> None:
        """Treat the URL's host as having answered 429: for a refusal that arrives in another form
        (Google's /sorry redirect), so it is honoured like one."""
        self._start_cooldown(host_of(url), retry_after)

    def _start_cooldown(self, host: str, retry_after: float | None) -> None:
        wait = DEFAULT_COOLDOWN_S if retry_after is None else min(max(retry_after, 1.0), MAX_COOLDOWN_S)
        until = time.time() + wait
        with self._cooldown_lock:
            self._cooldowns[host] = max(until, self._cooldowns.get(host, 0.0))
            merged = self._read_cooldowns()  # another process may have added hosts since we loaded
            for h, t in self._cooldowns.items():
                if t > time.time():
                    merged[h] = max(t, merged.get(h, 0.0))
            self._cooldowns = merged
            try:
                self._cooldown_file.parent.mkdir(parents=True, exist_ok=True)
                tmp = self._cooldown_file.with_suffix(f".{os.getpid()}-{threading.get_ident()}.tmp")
                tmp.write_text(json.dumps(merged))
                os.replace(tmp, self._cooldown_file)
            except OSError as e:
                logger.warning("could not save host cooldowns: %s", e)
        how = "as asked by Retry-After" if retry_after is not None else "(no Retry-After sent)"
        logger.warning("%s answered 429: no requests to it for %.0f s %s", host, wait, how)

    def _skipped(self, url: str, route: str, left: float) -> FetchResult:
        host = host_of(url)
        return FetchResult(
            url=url,
            status=429,
            route_used=route,
            error=f"skipped: {host} is cooling down after a 429 ({left:.0f} s left)",
            rate_limited=True,
            retry_after_s=left,
        )

    # ---- fetch --------------------------------------------------------------------------------
    def get(
        self,
        url: str,
        *,
        route: str = "direct",
        headers: dict[str, str | None] | None = None,
        conditional: bool = False,
        allow_fallback: bool = True,
        max_bytes: int = 5_000_000,
        follow_redirects: bool = True,
        hard_limit: bool = False,
    ) -> FetchResult:
        """GET through the host lock and cooldown. With follow_redirects=False a 3xx comes back as
        is (error "http 30x", `location` in headers), so the caller decides whether to go there.

        A body over `max_bytes` is cut to it; with `hard_limit` it is an error instead (`too_large`,
        nothing kept), and curl stops the transfer there (CURLOPT_MAXFILESIZE_LARGE). A header given as
        None drops that navigation default (an image request sends no Upgrade-Insecure-Requests)."""
        # The impersonation profile owns the User-Agent (and client hints); overriding it produces an
        # inconsistent client that WAFs score as a bot (Mondoweiss went from 403 to 200 on this alone).
        hdrs = dict(NAV_HEADERS)
        for k, v in (headers or {}).items():
            if k.lower() == "user-agent":
                continue
            if v is None:
                hdrs.pop(k, None)
            else:
                hdrs[k] = v
        if conditional:
            with self._state_lock:
                prev = self._state.get(url, {})
            if prev.get("etag"):
                hdrs["If-None-Match"] = prev["etag"]
            if prev.get("last_modified"):
                hdrs["If-Modified-Since"] = prev["last_modified"]

        host = host_of(url)
        with host_lock(host):
            # checked under the host lock: a thread that just got a 429 here has already said so
            left = self.cooldown_left(url)
            if left > 0:
                return self._skipped(url, route, left)
            limit = max_bytes if hard_limit else None
            result = self._attempt("GET", url, route, hdrs, max_bytes, follow=follow_redirects, limit=limit)
            if result.error and result.status == 0 and route == "direct" and not (result.refused or result.too_large):
                # second try on the same route before deciding the host is blocked
                result = self._attempt("GET", url, route, hdrs, max_bytes, follow=follow_redirects, limit=limit)
                if result.error and result.status == 0 and allow_fallback and result.blocked:
                    logger.info("%s unreachable directly (%s); trying Germany", url, result.error)
                    result = self._attempt("GET", url, "germany", hdrs, max_bytes, follow=follow_redirects, limit=limit)
                    result.fell_back = True
            if result.rate_limited:
                self._start_cooldown(host, result.retry_after_s)
        if result.ok and conditional:
            with self._state_lock:
                self._state[url] = {
                    "etag": result.headers.get("etag", ""),
                    "last_modified": result.headers.get("last-modified", ""),
                }
        return result

    def post(
        self,
        url: str,
        *,
        data: str | bytes,
        route: str = "direct",
        headers: dict[str, str] | None = None,
        max_bytes: int = 5_000_000,
    ) -> FetchResult:
        """One POST under the same host lock, fingerprint and cooldown as get(). No conditional
        headers and no Germany fallback."""
        p = urlsplit(url)
        hdrs = {**XHR_HEADERS, "Origin": f"{p.scheme}://{p.netloc}"}
        if headers:
            hdrs.update({k: v for k, v in headers.items() if k.lower() != "user-agent"})
        host = host_of(url)
        with host_lock(host):
            left = self.cooldown_left(url)
            if left > 0:
                return self._skipped(url, route, left)
            result = self._attempt("POST", url, route, hdrs, max_bytes, data=data)
            if result.rate_limited:
                self._start_cooldown(host, result.retry_after_s)
        return result

    def _attempt(
        self,
        method: str,
        url: str,
        route: str,
        hdrs: dict[str, str],
        max_bytes: int,
        data: str | bytes | None = None,
        follow: bool = True,
        limit: int | None = None,
    ) -> FetchResult:
        t0 = time.monotonic()
        res = FetchResult(url=url, status=0, route_used=route)
        try:
            # Redirects are followed here, so each hop's host is checked (and pinned) like the first.
            current, hops = url, 0
            while True:
                r = self._send(method, current, route, hdrs, data, limit=limit)
                res.status = r.status_code
                res.final_url = str(r.url) or current
                res.headers = {k.lower(): v for k, v in r.headers.items()}
                location = res.headers.get("location")
                if not (follow and r.status_code in _REDIRECTS and location) or hops == MAX_REDIRECTS:
                    break
                hops += 1
                current = urljoin(current, location)
                if r.status_code == 303 or (r.status_code in (301, 302) and method == "POST"):
                    method, data = "GET", None  # as a browser does
            if follow and r.status_code in _REDIRECTS and location:
                res.error = f"more than {MAX_REDIRECTS} redirects"
            elif r.status_code == 304:
                res.not_modified = True
            elif 200 <= r.status_code < 300:
                if limit is not None and len(r.content) > limit:
                    res.too_large, res.error = True, f"body over {limit} bytes"
                else:
                    res.content = r.content[:max_bytes]
            elif r.status_code == 429:
                res.rate_limited = True
                res.retry_after_s = parse_retry_after(res.headers.get("retry-after"))
                res.error = "http 429" + (f" (retry after {res.retry_after_s:.0f} s)" if res.retry_after_s else "")
            else:
                res.error = f"http {r.status_code}"
        except NotPublic as e:
            res.status, res.content, res.refused = 0, b"", True
            res.error = f"refused: {e}"
            logger.warning("refused %s: %s", url, e)
        except _Unresolved as e:
            res.status, res.content, res.blocked = 0, b"", True
            res.error = f"CouldNotResolve: {e}"
        except creq.exceptions.RequestException as e:
            code = getattr(e, "code", None)
            if code is None and isinstance(e.__cause__, CurlError):
                code = e.__cause__.code
            res.error = f"{type(e).__name__}: {str(e)[:160]}"
            res.blocked = int(code) in _BLOCKED_CODES if code is not None else False
            res.timed_out = isinstance(e, creq.exceptions.Timeout) or code == int(CurlECode.OPERATION_TIMEDOUT)
            res.too_large = code is not None and int(code) == int(CurlECode.FILESIZE_EXCEEDED)
        except CurlError as e:
            res.error = f"CurlError {e.code}: {str(e)[:160]}"
            res.blocked = int(e.code) in _BLOCKED_CODES
            res.timed_out = e.code == int(CurlECode.OPERATION_TIMEDOUT)
            res.too_large = int(e.code) == int(CurlECode.FILESIZE_EXCEEDED)
        res.ms = int((time.monotonic() - t0) * 1000)
        return res

    def _send(
        self,
        method: str,
        url: str,
        route: str,
        hdrs: dict[str, str],
        data: str | bytes | None,
        limit: int | None = None,
    ) -> Any:
        """One request, no redirects, to a public address only (NotPublic / _Unresolved otherwise).
        Direct: curl connects to exactly the addresses checked here. `limit`: curl gives up on a body
        larger than this many bytes."""
        direct = route == "direct"
        host, port, addrs = public_addresses(url, need_resolution=direct)
        pin: dict[Any, Any] = {}
        if direct and _literal_ip(host) is None:
            name = host.encode("idna").decode("ascii") if not host.isascii() else host
            joined = ",".join(f"[{a}]" if ":" in a else a for a in addrs)
            pin = {CurlOpt.RESOLVE: [f"+{name}:{port}:{joined}"]}  # "+": an ordinary, expiring cache entry
        if limit is not None:
            pin[CurlOpt.MAXFILESIZE_LARGE] = limit
        self._curl_opts[route].set(pin)
        try:
            return self._sessions[route].request(
                method, url, headers=hdrs, data=data, allow_redirects=False, max_recv_speed=0
            )
        finally:
            self._curl_opts[route].set({})
