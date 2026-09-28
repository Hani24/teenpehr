"""Turn items, posts, threads and stories into the numbered plain-text lists Claude reads.
Everything rendered here is data from the web; it is quoted, never trusted as instructions: it goes
in the user message only, inside <items> / <threads> blocks (`block`), each entry on one line with
anything that looks like those tags defused (`_clean`), and the prompts say so."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from .models import GlossaryEntry, StoryIn, Thread


@dataclass
class NumberedItem:
    idx: int
    kind: str  # "article" | "post"
    db_id: int
    title: str
    text: str = ""
    source_name: str = ""
    perspective: str = ""
    lang: str = "en"
    published: datetime | None = None
    url: str = ""
    author_handle: str = ""
    author_name: str = ""
    is_repost: bool = False
    source_id: int | None = None
    is_new: bool = True
    extra: dict = field(default_factory=dict)


def age(published: datetime | None, now: datetime | None = None) -> str:
    if not published:
        return "undated"
    now = now or datetime.now(UTC)
    secs = max(0, (now - published).total_seconds())
    if secs < 3600:
        return f"{int(secs // 60)}m ago"
    if secs < 86400:
        return f"{int(secs // 3600)}h ago"
    return f"{int(secs // 86400)}d ago"


# An opening or closing tag of a block we frame data with; in data it becomes ‹…› so it cannot end one.
_BLOCK_TAG = re.compile(r"<(\s*/?\s*(?:items|threads|stories|item|thread|story|system|instructions?)\b)", re.I)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# Invisible formatting that can hide or reorder text: zero-width space, direction marks, embeddings,
# overrides and isolates. Not ZWNJ/ZWJ (U+200C/D), which Urdu and Persian spelling needs.
_INVISIBLE = re.compile(r"[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]")


def defuse(text: str) -> str:
    """Untrusted text as one line: control characters and invisible formatting dropped, whitespace
    (newlines too) collapsed, block tags defused."""
    return _BLOCK_TAG.sub(r"‹\1", " ".join(_CONTROL.sub(" ", _INVISIBLE.sub("", text)).split()))


def _clean(text: str, limit: int) -> str:
    text = defuse(text)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def block(tag: str, body: str) -> str:
    """Data for the user message, framed so the prompt can point at it: <tag>…</tag>."""
    return f"<{tag}>\n{body}\n</{tag}>"


THREAD_TITLE_MAX = 120


def clean_thread_title(title: str) -> str:
    """A thread title as stored and shown back to the curate pass: one plain line, at most 120
    characters. It comes from a model that read untrusted items, so it is treated as data too."""
    return _clean(title, THREAD_TITLE_MAX)


MAX_ITEM_CHARS = 400  # title + text budget per item in the curation prompt (labels excluded)


def render_item(it: NumberedItem, now: datetime | None = None, max_chars: int = MAX_ITEM_CHARS) -> str:
    """One numbered line. Title and text together never exceed `max_chars`; the title wins."""
    if it.kind == "post":
        who = f"@{defuse(it.author_handle)}" + (f" · {defuse(it.author_name)}" if it.author_name else "")
        tag = " [repost]" if it.is_repost else ""
        return f"[{it.idx}] [post]{tag} ({who}, {age(it.published, now)}) {_clean(it.text, max_chars)}"
    label = defuse(it.source_name)
    if it.perspective:
        label += f" [{defuse(it.perspective)}]"
    if it.lang == "ur":
        label += " (Urdu)"
    elif it.lang not in ("en", ""):
        label += f" ({it.lang})"
    if not it.is_new:
        label += " (seen before)"
    title = _clean(it.title, min(200, max_chars))
    line = f"[{it.idx}] ({label}, {age(it.published, now)}) {title}"
    budget = max_chars - len(title) - 4  # " -- "
    text = defuse(it.text)
    if text and budget >= 40 and text_key(text) != text_key(title):
        line += f" -- {_clean(text, budget)}"
    return line


def text_key(text: str) -> str:
    return " ".join(text.lower().split())[:80]


def render_items(items: list[NumberedItem], now: datetime | None = None, max_chars: int = MAX_ITEM_CHARS) -> str:
    return "\n".join(render_item(i, now, max_chars) for i in items)


def render_threads(threads: list[Thread]) -> str:
    """Existing threads for the curate pass's user message (never its system prompt: a title was
    written by a model that read untrusted items). One line each, cleaned like any item text."""
    if not threads:
        return "(none)"
    return "\n".join(f"- {defuse(t.slug)}: {clean_thread_title(t.title_en)}" for t in threads)


GLOSSARY_LIMIT = 400


def _mentions(text: str, term: str) -> bool:
    """Whole-word, case-sensitive: "Dawn" the outlet, not "dawn" the time of day."""
    return re.search(rf"(?<!\w){re.escape(term)}(?!\w)", text) is not None


def render_glossary(entries: list[GlossaryEntry], limit: int = GLOSSARY_LIMIT, text: str | None = None) -> str:
    """Two lists for the Urdu prompt. Locked entries (approved by the editor) are mandatory and are
    always all included, however many there are. Unlocked entries are earlier runs' proposals nobody
    has reviewed, offered as suggestions: with `text`, only those whose English term occurs in it, and
    only as many as fit in `limit` after the locked ones."""
    locked = sorted((e for e in entries if e.locked), key=lambda e: e.term_en)
    unlocked = sorted((e for e in entries if not e.locked), key=lambda e: e.term_en)
    if text is not None:
        unlocked = [e for e in unlocked if _mentions(text, e.term_en)]
    unlocked = unlocked[: max(0, limit - len(locked))]

    def lines(es: list[GlossaryEntry]) -> str:
        return "\n".join(f"- {e.term_en} → {e.term_ur}" for e in es) or "(none)"

    return f"Locked (mandatory):\n{lines(locked)}\n\nSuggested (not yet reviewed):\n{lines(unlocked)}"


def render_stories_for_urdu(lead_en: str, stories: list[StoryIn], source_names: dict[int, str]) -> str:
    lines = [f"Lead (English): {lead_en}", ""]
    for i, s in enumerate(stories, 1):
        outlets = ", ".join(dict.fromkeys(source_names.get(r.item_id, "?") for r in s.sources))
        lines.append(f"Story {i}")
        if s.thread_title_en:
            lines.append(f"Thread title: {s.thread_title_en}")
        lines.append(f"Title: {s.title_en}")
        lines.append(f"Summary: {s.summary_en}")
        if s.why_en:
            lines.append(f"Why it matters: {s.why_en}")
        if s.contested_en:
            lines.append(f"Contested: {s.contested_en}")
        for j, a in enumerate(s.angles, 1):
            lines.append(f"Angle {j} ({source_names.get(a.item_id, '?')}): {a.note_en}")
        if s.entities:
            lines.append(f"Entities: {'; '.join(e.name_en for e in s.entities)}")
        lines.append(f"Outlets: {outlets}")
        lines.append("")
    return "\n".join(lines).strip()


def render_stories_for_qa(stories: list[StoryIn], by_ref: dict[tuple[str, int], NumberedItem]) -> str:
    """`by_ref` is keyed by (kind, db_id): items and posts live in separate tables whose ids overlap,
    so a bare id could show the checker a post as a story's cited article."""
    lines: list[str] = []
    for i, s in enumerate(stories, 1):
        lines.append(f"Story {i}")
        lines.append(f"Title (en): {s.title_en}")
        lines.append(f"Summary (en): {s.summary_en}")
        if s.why_en:
            lines.append(f"Why (en): {s.why_en}")
        if s.contested_en:
            lines.append(f"Contested (en): {s.contested_en}")
        if s.title_ur:
            lines.append(f"Title (ur): {s.title_ur}")
            lines.append(f"Summary (ur): {s.summary_ur}")
        lines.append("Cited items:")
        for r in s.sources:
            it = by_ref.get(("article", r.item_id))
            if it:
                lines.append(f"  - ({it.source_name}) {_clean(it.title, 200)} -- {_clean(it.text, 600)}")
        posts = [p for p in (by_ref.get(("post", pid)) for pid in s.posts) if p]
        if posts:
            lines.append("Attached posts:")
            for p in posts:
                lines.append(f"  - @{p.author_handle}: {_clean(p.text, 400)}")
        lines.append("")
    return "\n".join(lines).strip()
