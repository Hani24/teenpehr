"""Article text extraction (trafilatura) for feeds that only give titles or short blurbs."""

from __future__ import annotations

import trafilatura

MAX_CHARS = 2000


def extract_text(html: bytes | str, url: str | None = None, max_chars: int = MAX_CHARS) -> str:
    if isinstance(html, bytes):
        html = html.decode("utf-8", "ignore")
    text = trafilatura.extract(
        html, url=url, include_comments=False, include_tables=False, favor_precision=True, deduplicate=True
    )
    if not text:
        return ""
    text = " ".join(text.split())
    if len(text) > max_chars:
        cut = text[:max_chars]
        text = cut[: cut.rfind(" ")] + " …"
    return text
