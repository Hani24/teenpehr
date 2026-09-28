"""The Fetcher reaches only the public internet: links and redirects from untrusted feeds must never
make the worker request loopback, LAN or link-local addresses (teenpehr.fetch.http)."""

from __future__ import annotations

import ipaddress
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from teenpehr.fetch import http
from teenpehr.fetch.article import ArticleFetcher


class _Server:
    """A local HTTP server on `host` that records every path it is asked for."""

    def __init__(self, host: str, routes: dict[str, tuple[int, dict[str, str], bytes]]):
        seen = self.seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                seen.append(self.path)
                status, headers, body = routes.get(self.path.split("?", 1)[0], (404, {}, b"no"))
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer((host, 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def servers():
    made: list[_Server] = []

    def make(host: str, routes):
        s = _Server(host, routes)
        made.append(s)
        return s

    yield make
    for s in made:
        s.close()


def _pretend_public(monkeypatch, allowed: set[str], names: dict[str, str] | None = None):
    """Treat these loopback addresses as public (stand-ins for a real site), and answer made-up
    names with them, so real curl requests can run against local servers."""
    real_check, real_resolve = http.is_public_ip, http._getaddrinfo
    monkeypatch.setattr(http, "is_public_ip", lambda ip: str(ip) in allowed or real_check(ip))

    def resolve(host, port, *a, **kw):
        if names and host in names:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (names[host], port or 0))]
        return real_resolve(host, port, *a, **kw)

    monkeypatch.setattr(http, "_getaddrinfo", resolve)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "198.18.0.1",
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "fd12::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "64:ff9b::7f00:1",
        "2002:7f00:1::1",
        "ff02::1",
    ],
)
def test_non_public_addresses(ip):
    assert not http.is_public_ip(ipaddress.ip_address(ip))


@pytest.mark.parametrize("ip", ["8.8.8.8", "93.184.215.14", "2606:4700:4700::1111"])
def test_public_addresses(ip):
    assert http.is_public_ip(ipaddress.ip_address(ip))


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://[::1]:8080/",
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost/",
        "http://printer.local/",
        "http://intranet/",
        "http://2130706433/",
        "http://0x7f.1/",
        "http://127.1/",
        "http://metadata.google.internal/",
        "file:///etc/passwd",
        "ftp://example.com/",
    ],
)
def test_public_addresses_refuses_local_urls(url):
    with pytest.raises(http.NotPublic):
        http.public_addresses(url)


def test_a_name_that_resolves_to_a_private_address_is_refused(monkeypatch):
    _pretend_public(monkeypatch, set(), {"evil.example.com": "10.0.0.5"})
    with pytest.raises(http.NotPublic):
        http.public_addresses("https://evil.example.com/x")


def test_direct_request_to_loopback_is_never_sent(settings, servers):
    local = servers("127.0.0.1", {"/secret": (200, {}, b"internal status page")})
    f = http.Fetcher(settings)
    res = f.get(f"http://127.0.0.1:{local.port}/secret")
    assert res.refused and not res.ok and res.content == b"" and res.error.startswith("refused")
    assert not res.fell_back  # a refusal never tries the Germany route
    assert local.seen == []


def test_redirect_to_an_internal_address_is_refused(settings, servers, monkeypatch):
    inside = servers("127.0.0.2", {"/secret": (200, {}, b"internal")})
    outside = servers(
        "127.0.0.1",
        {
            "/to-ip": (302, {"Location": f"http://127.0.0.2:{inside.port}/secret"}, b""),
            "/to-name": (301, {"Location": f"http://localhost:{inside.port}/secret"}, b""),
            "/to-meta": (307, {"Location": "http://169.254.169.254/latest/meta-data/"}, b""),
        },
    )
    _pretend_public(monkeypatch, {"127.0.0.1"})
    f = http.Fetcher(settings)
    for path in ("/to-ip", "/to-name", "/to-meta"):
        res = f.get(f"http://127.0.0.1:{outside.port}{path}")
        assert res.refused and not res.ok and res.content == b"", path
    assert inside.seen == [] and outside.seen == ["/to-ip", "/to-name", "/to-meta"]


def test_redirects_between_public_addresses_are_followed(settings, servers, monkeypatch):
    b = servers("127.0.0.3", {"/page": (200, {}, b"the article")})
    a = servers("127.0.0.1", {"/start": (302, {"Location": f"http://127.0.0.3:{b.port}/page"}, b"")})
    _pretend_public(monkeypatch, {"127.0.0.1", "127.0.0.3"})
    res = http.Fetcher(settings).get(f"http://127.0.0.1:{a.port}/start")
    assert res.ok and res.content == b"the article" and res.final_url.endswith("/page")


def test_the_connection_goes_to_the_checked_address(settings, servers, monkeypatch):
    """curl is pinned to what the guard resolved: it reaches a name no real resolver knows."""
    site = servers("127.0.0.1", {"/ok": (200, {}, b"pinned")})
    _pretend_public(monkeypatch, {"127.0.0.1"}, {"pinned-site.test": "127.0.0.1"})
    res = http.Fetcher(settings).get(f"http://pinned-site.test:{site.port}/ok")
    assert res.ok and res.content == b"pinned"


def test_pins_stay_with_their_own_thread(settings, servers, monkeypatch):
    one = servers("127.0.0.1", {"/x": (200, {}, b"one")})
    two = servers("127.0.0.3", {"/x": (200, {}, b"two")})
    _pretend_public(monkeypatch, {"127.0.0.1", "127.0.0.3"}, {"one.test": "127.0.0.1", "two.test": "127.0.0.3"})
    f = http.Fetcher(settings)
    wrong: list[str] = []

    def run(name: str, port: int, want: bytes):
        for i in range(15):
            r = f.get(f"http://{name}:{port}/x?{i}")
            if r.content != want:
                wrong.append(f"{name}: {r.status} {r.error}")

    threads = [
        threading.Thread(target=run, args=a) for a in (("one.test", one.port, b"one"), ("two.test", two.port, b"two"))
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert wrong == []


def test_germany_route_refuses_what_it_can_see_is_local(settings, monkeypatch):
    _pretend_public(monkeypatch, set(), {"rebind.example.com": "192.168.0.10"})
    f = http.Fetcher(settings)
    sent = []
    f._sessions["germany"].request = lambda *a, **kw: sent.append(a)
    for url in ("http://10.0.0.1/", "http://localhost:8080/", "http://rebind.example.com/"):
        res = f.get(url, route="germany")
        assert res.refused and not res.ok, url
    assert sent == []


def test_article_links_to_internal_hosts_fetch_nothing(settings, servers):
    local = servers("127.0.0.1", {"/robots.txt": (404, {}, b""), "/admin": (200, {}, b"<p>secret</p>")})
    a = ArticleFetcher(http.Fetcher(settings))
    assert a.fetch_text(f"http://127.0.0.1:{local.port}/admin") == ""
    assert local.seen == []
