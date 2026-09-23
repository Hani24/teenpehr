"""Turn items, posts, threads and stories into the numbered plain-text lists Claude reads.
Everything rendered here is data from the web; it is quoted, never trusted as instructions."""

from __future__ import annotations

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


def _clean(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


MAX_ITEM_CHARS = 400  # title + text budget per item in the curation prompt (labels excluded)


def render_item(it: NumberedItem, now: datetime | None = None, max_chars: int = MAX_ITEM_CHARS) -> str:
    """One numbered line. Title and text together never exceed `max_chars`; the title wins."""
    if it.kind == "post":
        who = f"@{it.author_handle}" + (f" · {it.author_name}" if it.author_name else "")
        tag = " [repost]" if it.is_repost else ""
        return f"[{it.idx}] [post]{tag} ({who}, {age(it.published, now)}) {_clean(it.text, max_chars)}"
    label = it.source_name
    if it.perspective:
        label += f" [{it.perspective}]"
    if it.lang == "ur":
        label += " (Urdu)"
    elif it.lang not in ("en", ""):
        label += f" ({it.lang})"
    if not it.is_new:
        label += " (seen before)"
    title = _clean(it.title, min(200, max_chars))
    line = f"[{it.idx}] ({label}, {age(it.published, now)}) {title}"
    budget = max_chars - len(title) - 4  # " -- "
    text = " ".join(it.text.split())
    if text and budget >= 40 and text_key(text) != text_key(title):
        line += f" -- {_clean(text, budget)}"
    return line


def text_key(text: str) -> str:
    return " ".join(text.lower().split())[:80]


def render_items(items: list[NumberedItem], now: datetime | None = None, max_chars: int = MAX_ITEM_CHARS) -> str:
    return "\n".join(render_item(i, now, max_chars) for i in items)


def render_threads(threads: list[Thread]) -> str:
    if not threads:
        return "(none)"
    return "\n".join(f"- {t.slug}: {t.title_en}" for t in threads)


def render_glossary(entries: list[GlossaryEntry], limit: int = 400) -> str:
    return "\n".join(f"- {e.term_en} → {e.term_ur}" for e in entries[:limit]) or "(none)"


def render_stories_for_urdu(lead_en: str, stories: list[StoryIn], source_names: dict[int, str]) -> str:
    lines = [f"Lead (English): {lead_en}", ""]
    for i, s in enumerate(stories, 1):
        outlets = ", ".join(dict.fromkeys(source_names.get(r.item_id, "?") for r in s.sources))
        lines.append(f"Story {i}")
        lines.append(f"Title: {s.title_en}")
        lines.append(f"Summary: {s.summary_en}")
        if s.why_en:
            lines.append(f"Why it matters: {s.why_en}")
        if s.contested_en:
            lines.append(f"Contested: {s.contested_en}")
        for j, a in enumerate(s.angles, 1):
            lines.append(f"Angle {j} ({source_names.get(a.item_id, '?')}): {a.note_en}")
        lines.append(f"Outlets: {outlets}")
        lines.append("")
    return "\n".join(lines).strip()


def render_stories_for_qa(stories: list[StoryIn], items_by_id: dict[int, NumberedItem]) -> str:
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
            it = items_by_id.get(r.item_id)
            if it:
                lines.append(f"  - ({it.source_name}) {_clean(it.title, 200)} -- {_clean(it.text, 600)}")
        lines.append("")
    return "\n".join(lines).strip()
