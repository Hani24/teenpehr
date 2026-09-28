"""robots.txt as RFC 9309 reads it, for article-page fetches (feeds are fetched as feeds).

The group naming our product token wins, else the `*` group(s); within it the longest matching
rule decides and Allow wins a tie; `*` and a trailing `$` work as wildcards. Crawl-delay is not
in the RFC but many news sites set it, so it is read from the same group. Python 3.12's
urllib.robotparser applies the first matching rule and has no wildcards, which misreads common
files such as `Disallow: /` followed by `Allow: /news/`."""

from __future__ import annotations

import contextlib
import re
from dataclasses import dataclass, field
from urllib.parse import quote, unquote, urlsplit

AGENT = "teenpehr"  # the product token looked up in robots.txt; sites that do not name it fall to `*`
_SAFE = "/?&=:;@!$'()*+,~-._"


def _norm(path: str) -> str:
    """One percent-encoding for rules and URLs alike, so `%7E` and `~` compare equal."""
    return quote(unquote(path), safe=_SAFE)


@dataclass
class _Group:
    agents: list[str] = field(default_factory=list)
    rules: list[tuple[bool, str]] = field(default_factory=list)  # (allow, normalised pattern)
    crawl_delay: float | None = None


def _parse(text: str) -> list[_Group]:
    groups: list[_Group] = []
    current: _Group | None = None
    in_agents = False  # consecutive user-agent lines share one group
    for raw in text.lstrip("﻿").splitlines():
        key, sep, value = raw.split("#", 1)[0].partition(":")
        if not sep:
            continue
        key, value = key.strip().lower(), value.strip()
        if key == "user-agent":
            if current is None or not in_agents:
                current = _Group()
                groups.append(current)
            current.agents.append(value.split("/", 1)[0].strip().lower())
            in_agents = True
        elif key in ("allow", "disallow") and current is not None:
            in_agents = False
            if value:  # an empty Disallow allows everything, which is the default anyway
                if not value.startswith(("/", "*")):
                    value = "/" + value
                current.rules.append((key == "allow", _norm(value)))
        elif key == "crawl-delay" and current is not None:
            in_agents = False
            with contextlib.suppress(ValueError):
                current.crawl_delay = max(0.0, float(value))
    return groups


def _compile(pattern: str) -> re.Pattern[str]:
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    return re.compile(".*".join(re.escape(part) for part in body.split("*")) + (r"\Z" if anchored else ""), re.S)


class Robots:
    """One host's robots.txt. `Robots()` (no file, or a 4xx) allows everything;
    `Robots.unreachable()` (5xx, timeout, refused) allows nothing, as RFC 9309 2.3.1 asks."""

    def __init__(self, text: str = "", *, allow_nothing: bool = False):
        self.allow_nothing = allow_nothing
        self._groups = _parse(text) if text else []
        self._by_agent: dict[str, tuple[list[tuple[bool, int, re.Pattern[str]]], float | None]] = {}

    @classmethod
    def unreachable(cls) -> Robots:
        return cls(allow_nothing=True)

    def _for(self, agent: str) -> tuple[list[tuple[bool, int, re.Pattern[str]]], float | None]:
        token = agent.lower()
        if token not in self._by_agent:
            groups = [g for g in self._groups if token in g.agents] or [g for g in self._groups if "*" in g.agents]
            rules = [(allow, len(p), _compile(p)) for g in groups for allow, p in g.rules]
            delays = [g.crawl_delay for g in groups if g.crawl_delay is not None]
            self._by_agent[token] = (rules, max(delays) if delays else None)
        return self._by_agent[token]

    def allowed(self, url: str, agent: str = AGENT) -> bool:
        if self.allow_nothing:
            return False
        p = urlsplit(url)
        path = _norm((p.path or "/") + (f"?{p.query}" if p.query else ""))
        if path == "/robots.txt":
            return True
        best, verdict = -1, True
        for allow, length, rx in self._for(agent)[0]:
            if (length > best or (length == best and allow)) and rx.match(path):
                best, verdict = length, allow
        return verdict

    def crawl_delay(self, agent: str = AGENT) -> float | None:
        return None if self.allow_nothing else self._for(agent)[1]
