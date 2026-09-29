"""Verify candidate public X Lists for a group and write them as proposals (decision D10).

    uv run python -m teenpehr.fetch.xlist_audit --group pakistan 1234567890123456789 2345678901234567890
    uv run python -m teenpehr.fetch.xlist_audit --group pakistan <ids…> --write ../web/db/seed/x-list-proposals.json

A list is given by its numeric id (the digits of x.com/i/lists/<id>). The old owner/slug address
(twitter.com/<owner>/lists/<slug>) is refused before any request: on 29 September 2026 the syndication
endpoint's screen-name/slug route answered 429 every time while the list-id route answered at once, and
a 429 puts X on a 15-minute cooldown for every process here, the X collector included. Each list is
read once through the same syndication endpoint the X collector uses (`social/x_list.py`), direct route
only, at least `--spacing` seconds apart; a 429 stops the run (the Fetcher then keeps every process off
the host for its cooldown) and the lists not yet read are named. The page gives the list's numeric id,
name, owner and member count, and up to about 100 recent posts, from which this reports: entries, distinct
authors, the newest post's age, reposts, overlap with the watched handles (`web/db/seed/handles.json`) and
the share of authors with at least one post on the group's subjects.

`--write` merges the lists that pass (enough fresh entries, enough relevant authors) into the proposals
file as a bare JSON array, one entry per (group, list id). That file is only ever a proposal: the admin
shows it and an owner's "Add to group" is the only thing that puts a list id into `groups.x_list_ids`.
Nothing here writes to the database. Post texts are untrusted data: they are counted and matched against
keywords, never followed or obeyed."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .. import log
from ..config import Settings
from ..social.x_list import _NEXT_DATA_RE, XListError, XRateLimited, fetch_html, parse_timeline_html
from .http import Fetcher

logger = log.get("fetch.xlist_audit")

LIST_ID_URL = "https://syndication.twitter.com/srv/timeline-list/list-id/{}"
SPACING_S = 10.0
MIN_ENTRIES = 20
MAX_AGE_H = 48.0
MIN_RELEVANT = 0.3  # share of a list's authors with at least one post on the group's subjects

_ID_RE = re.compile(r"[0-9]{5,25}")  # ASCII digits only, whole string (fullmatch): the column's own check
_SLUG_RE = re.compile(r"^@?([A-Za-z0-9_]{1,15})/(?:lists/)?([A-Za-z0-9_-]{1,25})$")

# The group's subjects, from web/db/seed/groups.json briefs. Case-insensitive; Urdu forms included where
# the lists are likely to post in Urdu.
GROUP_KEYWORDS: dict[str, str] = {
    "pakistan": r"pakistan|islamabad|karachi|lahore|peshawar|quetta|balochistan|khyber|sindh|punjab|imran khan|"
    r"\bpti\b|pml-?n|\bppp\b|ispr|shehbaz|پاکستان|اسلام آباد|کراچی|لاہور|پشاور|بلوچستان",
    "india": r"india|delhi|modi|\bbjp\b|congress|kashmir|mumbai|manipur|lok sabha|hindutva|بھارت|ہندوستان|کشمیر",
    "afghanistan": r"afghan|kabul|taliban|kandahar|herat|\bttp\b|durand|افغان|کابل|طالبان",
    "middle-east": r"gaza|israel|palestin|west bank|iran|tehran|lebanon|hezbollah|hamas|syria|yemen|houthi|iraq|"
    r"saudi|\buae\b|emirat|qatar|egypt|turkey|türkiye|jordan",
    "muslim-world": r"bangladesh|dhaka|indonesia|jakarta|malaysia|uyghur|xinjiang|rohingya|myanmar|sudan|darfur|"
    r"somalia|nigeria|uzbek|kazakh|kyrgyz|tajik|turkmen|muslim|islamophobia",
    "world": r"united nations|\bun\b|china|beijing|russia|moscow|ukraine|kyiv|nato|washington|white house|"
    r"trump|climate|\bimf\b|world bank|g20|brics",
}


@dataclass
class ListCheck:
    ref: str
    group: str
    ok: bool
    error: str = ""
    list_id: str | None = None
    name: str = ""
    owner: str = ""
    members: int | None = None
    entries: int = 0
    authors: int = 0
    reposts: int = 0
    newest_at: str | None = None
    newest_h: float | None = None
    overlap: list[str] = field(default_factory=list)
    relevant_authors: int = 0
    relevant_share: float = 0.0
    sample_authors: list[str] = field(default_factory=list)
    checked_at: str = ""


def list_url(ref: str) -> str:
    """The syndication URL for a numeric list id (or an x.com/i/lists/<id> link). Raises ValueError for
    anything else, with a pointer for an owner/slug address (see the module docstring)."""
    ref = ref.strip().removeprefix("https://").removeprefix("http://").removeprefix("www.")
    ref = ref.removeprefix("x.com/i/lists/").removeprefix("twitter.com/i/lists/").rstrip("/")
    if _ID_RE.fullmatch(ref):
        return LIST_ID_URL.format(ref)
    if _SLUG_RE.match(ref.removeprefix("x.com/").removeprefix("twitter.com/")):
        raise ValueError(f"{ref!r} is an owner/slug address, which the endpoint no longer serves: give the numeric id")
    raise ValueError(f"not a list id: {ref!r}")


def page_meta(html: str) -> dict[str, Any]:
    """The list's id, name, owner and member count from the page's __NEXT_DATA__ (missing keys absent)."""
    m = _NEXT_DATA_RE.search(html)
    if not m:
        return {}
    try:
        pp = json.loads(m.group(1))["props"]["pageProps"]
    except (ValueError, KeyError, TypeError):
        return {}
    head = pp.get("headerProps") if isinstance(pp.get("headerProps"), dict) else {}
    owner = head.get("owner") if isinstance(head.get("owner"), dict) else {}
    out: dict[str, Any] = {}
    lid = str(pp.get("listId") or "")
    if _ID_RE.fullmatch(lid):
        out["list_id"] = lid
    if isinstance(head.get("name"), str):
        out["name"] = " ".join(head["name"].split())[:200]
    if isinstance(owner.get("screenName"), str):
        out["owner"] = owner["screenName"][:50]
    if isinstance(head.get("memberCount"), int) and head["memberCount"] >= 0:
        out["members"] = head["memberCount"]
    return out


def check_page(html: str, ref: str, group: str, watched: set[str], *, now: datetime) -> ListCheck:
    """Everything this audit reports about one list page. Raises XListError for a page without posts."""
    posts = parse_timeline_html(html)
    meta = page_meta(html)
    rx = re.compile(GROUP_KEYWORDS.get(group, r"(?!)"), re.I)
    authors = Counter(p.author_handle for p in posts)
    relevant = {p.author_handle for p in posts if rx.search(p.text)}
    newest = max((p.posted_at for p in posts), default=None)
    return ListCheck(
        ref=ref,
        group=group,
        ok=True,
        list_id=meta.get("list_id") or (ref if _ID_RE.fullmatch(ref) else None),
        name=meta.get("name", ""),
        owner=meta.get("owner", ""),
        members=meta.get("members"),
        entries=len(posts),
        authors=len(authors),
        reposts=sum(1 for p in posts if p.is_repost),
        newest_at=newest.isoformat(timespec="seconds") if newest else None,
        newest_h=round((now - newest).total_seconds() / 3600, 1) if newest else None,
        overlap=sorted(h for h in authors if h.lower() in watched),
        relevant_authors=len(relevant),
        relevant_share=round(len(relevant) / len(authors), 2) if authors else 0.0,
        sample_authors=[h for h, _ in authors.most_common(12)],
        checked_at=now.isoformat(timespec="seconds"),
    )


def verdict(
    c: ListCheck, *, min_entries: int = MIN_ENTRIES, max_age_h: float = MAX_AGE_H, min_relevant: float = MIN_RELEVANT
) -> tuple[bool, str]:
    """(worth proposing, why not)."""
    if not c.ok:
        return False, c.error or "not read"
    if not c.list_id:
        return False, "the page gave no numeric list id"
    if c.entries < min_entries:
        return False, f"only {c.entries} entries"
    if c.newest_h is None or c.newest_h > max_age_h:
        return False, f"newest post {c.newest_h} h old"
    if c.relevant_share < min_relevant:
        return False, f"only {c.relevant_share:.0%} of its authors post on {c.group}"
    return True, ""


def to_proposal(c: ListCheck) -> dict[str, Any]:
    """One entry of web/db/seed/x-list-proposals.json (read by the admin and by apply-sources --proposals)."""
    note = (
        f"Verified {c.checked_at}: {c.entries} recent posts ({c.reposts} of them reposts) from {c.authors} accounts, "
        f"newest {c.newest_h} h old; {c.relevant_share:.0%} of the accounts posted on the {c.group} group's subjects; "
        f"{len(c.overlap)} already watched" + (f" ({', '.join(c.overlap[:8])})" if c.overlap else "") + "."
    )
    return {
        "group": c.group,
        "list_id": c.list_id,
        "name": c.name,
        "owner": c.owner,
        "url": f"https://x.com/i/lists/{c.list_id}",
        "members": c.members,
        "entries": c.entries,
        "newest_post_at": c.newest_at,
        "verified_at": c.checked_at,
        "overlap": c.overlap,
        "sample_authors": c.sample_authors,
        "notes": note,
    }


def merge(path: Path, proposals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The file's proposals with these added or replaced by (group, list id); written as a bare array."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = []
    old = raw if isinstance(raw, list) else raw.get("proposals", []) if isinstance(raw, dict) else []
    new_keys = {(p["group"], p["list_id"]) for p in proposals}
    kept = [p for p in old if isinstance(p, dict) and (p.get("group"), str(p.get("list_id"))) not in new_keys]
    out = kept + proposals
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def watched_handles(path: Path) -> set[str]:
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    return {str(r.get("handle", "")).lstrip("@").lower() for r in rows if r.get("platform", "x") == "x"}


def run(
    refs: list[str], group: str, get, watched: set[str], *, spacing_s: float = SPACING_S, now: datetime | None = None
) -> tuple[list[ListCheck], list[str]]:
    """Checks for `refs` in order, and the refs left unread after a rate limit. `get(url) -> html`."""
    checks: list[ListCheck] = []
    for i, ref in enumerate(refs):
        if i and spacing_s:
            time.sleep(spacing_s)
        when = now or datetime.now(UTC)
        try:
            html = get(list_url(ref))
            checks.append(check_page(html, ref, group, watched, now=when))
        except XRateLimited as e:
            checks.append(ListCheck(ref=ref, group=group, ok=False, error=f"rate limited: {e}"[:200]))
            return checks, refs[i + 1 :]
        except (XListError, ValueError) as e:
            checks.append(ListCheck(ref=ref, group=group, ok=False, error=str(e)[:200]))
    return checks, []


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m teenpehr.fetch.xlist_audit", description=__doc__.split("\n\n")[0])
    ap.add_argument("refs", nargs="+", help="numeric list ids (or x.com/i/lists/<id> links)")
    ap.add_argument("--group", required=True, choices=sorted(GROUP_KEYWORDS))
    ap.add_argument("--handles", default="../web/db/seed/handles.json")
    ap.add_argument("--write", help="merge the lists that pass into this proposals file")
    ap.add_argument("--out", help="write every check as JSON here")
    ap.add_argument("--spacing", type=float, default=SPACING_S)
    ap.add_argument("--min-entries", type=int, default=MIN_ENTRIES)
    ap.add_argument("--max-age-h", type=float, default=MAX_AGE_H)
    ap.add_argument("--min-relevant", type=float, default=MIN_RELEVANT)
    args = ap.parse_args(argv)
    log.setup("INFO")
    settings = Settings()
    settings.state_dir.mkdir(parents=True, exist_ok=True)
    fetch = fetch_html(Fetcher(settings))
    checks, left = run(
        args.refs,
        args.group,
        lambda url: fetch(url, {"Accept": "text/html,application/xhtml+xml"}),
        watched_handles(Path(args.handles)),
        spacing_s=args.spacing,
    )
    passing: list[dict[str, Any]] = []
    for c in checks:
        good, why = verdict(c, min_entries=args.min_entries, max_age_h=args.max_age_h, min_relevant=args.min_relevant)
        head = f"{c.ref:40} " + (
            f"id {c.list_id} {c.name!r} by @{c.owner}: {c.entries} posts, {c.authors} authors, "
            f"newest {c.newest_h} h, relevant {c.relevant_share:.0%}, overlap {len(c.overlap)}"
            if c.ok
            else c.error
        )
        print(("PROPOSE " if good else "skip    ") + head + ("" if good else f"  [{why}]"))
        if good:
            passing.append(to_proposal(c))
    if left:
        print(f"stopped by a rate limit; not read: {' '.join(left)}")
    if args.out:
        Path(args.out).write_text(
            json.dumps([asdict(c) for c in checks], ensure_ascii=False, indent=2), encoding="utf-8"
        )
    if args.write and passing:
        merge(Path(args.write), passing)
        print(f"{len(passing)} proposal(s) merged into {args.write}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
