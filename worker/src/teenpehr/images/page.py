"""Where a publisher's image is: which image URLs are worth downloading, and the lead image an
article page declares (og:image, twitter:image, schema.org JSON-LD, link rel=image_src).

Everything read here comes from pages we do not control: a URL is kept only when it is http(s),
not an SVG and not a data: URI, and the alt text is kept only as the publisher wrote it (the web
app makes it one line and cuts it); nothing here ever reaches a prompt."""

from __future__ import annotations

import contextlib
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlsplit

from lxml import html as lxml_html

MAX_URL = 2000  # the API's limit for source_url
MAX_JSONLD_BYTES = 200_000  # per <script type="application/ld+json">; larger blocks are skipped
MAX_ALT = 500
_XML_DECL = re.compile(r"^\s*<\?xml[^>]*\?>")
# Control characters (a CR/LF would end up in a request line or header): such a URL is never fetched.
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

# A last path segment that names a site's stock picture rather than a photo. Separator-bounded, so
# YouTube's "hqdefault.jpg" (a real video still) is not caught by "default".
_STOCK_NAME = re.compile(
    r"(?:^|[-_.])(?:placeholder|logo|logos|noimage|no-image|no_image|blank|spacer|favicon|sprite|default)(?:[-_.]|$)",
    re.I,
)
# Google's wrappers and proxies: never the publisher's own picture (a Google News item's image comes
# from the decoded publisher page instead).
_GOOGLE_HOST = re.compile(r"(?:^|\.)(?:google\.[a-z]{2,3}(?:\.[a-z]{2})?|googleusercontent\.com|gstatic\.com)$")


@dataclass
class PageImage:
    url: str
    alt: str | None = None


def is_google_host(url: str) -> bool:
    return bool(_GOOGLE_HOST.search((urlsplit(url).hostname or "").lower().rstrip(".")))


def usable_image_url(url: str | None) -> bool:
    """An absolute http(s) URL that may be a photo: not a data: URI, not an SVG, not a Google News
    wrapper, not a file named like a logo or placeholder, and short enough for the API."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL or _CONTROL.search(url):
        return False
    try:
        p = urlsplit(url.strip())
    except ValueError:
        return False
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    path = p.path.lower()
    if path.endswith((".svg", ".svgz")) or "image/svg" in url.lower():
        return False
    if (p.hostname or "").lower() == "news.google.com":
        return False
    last = path.rsplit("/", 1)[-1]
    return not _STOCK_NAME.search(last.rsplit(".", 1)[0] if "." in last else last)


def _clean_alt(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    text = " ".join(v.split())
    return text[:MAX_ALT] or None


def _abs(base: str, value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    v = value.strip()
    if v.lower().startswith("data:"):
        return None
    try:
        u = urljoin(base, v)
    except ValueError:
        return None
    return u if usable_image_url(u) else None


def _int(v: Any) -> int | None:
    try:
        return int(str(v).strip().split(".")[0])
    except (TypeError, ValueError):
        return None


def _jsonld_images(node: Any, depth: int = 0) -> list[tuple[Any, Any]]:
    """(url, caption) pairs from a JSON-LD article's `image` (a string, a list, or an ImageObject);
    articles are found at the top level, in a list, or in @graph."""
    if depth > 4:
        return []
    out: list[tuple[Any, Any]] = []
    if isinstance(node, list):
        for x in node[:50]:
            out += _jsonld_images(x, depth + 1)
        return out
    if not isinstance(node, dict):
        return out
    if "@graph" in node:
        out += _jsonld_images(node["@graph"], depth + 1)
    kind = node.get("@type")
    kinds = {kind} if isinstance(kind, str) else set(kind) if isinstance(kind, list) else set()
    if not any(isinstance(k, str) and ("Article" in k or k in ("BlogPosting", "WebPage")) for k in kinds):
        return out
    img = node.get("image")
    for one in img if isinstance(img, list) else [img]:
        if isinstance(one, str):
            out.append((one, None))
        elif isinstance(one, dict):
            out.append((one.get("url") or one.get("contentUrl"), one.get("caption")))
    return out


def page_images(page: bytes | str, page_url: str) -> list[PageImage]:
    """The lead-image candidates a page declares, best first: og:image (with its og:image:alt; one
    whose og:image:width is under 300 is skipped), twitter:image, the article's schema.org image, then
    link rel=image_src. Relative URLs are resolved against the page (or its <base href>)."""
    if isinstance(page, bytes):
        with contextlib.suppress(UnicodeDecodeError):  # not UTF-8: lxml reads the page's own charset
            page = page.decode("utf-8")
    if isinstance(page, str):
        page = _XML_DECL.sub("", page, count=1)  # lxml refuses a str that declares its encoding
    if not page.strip():
        return []
    try:
        doc = lxml_html.document_fromstring(page)
    except (ValueError, lxml_html.etree.ParserError):
        return []
    base = page_url
    for b in doc.iter("base"):
        href = b.get("href")
        if href:
            base = urljoin(page_url, href.strip())
        break

    og: list[dict[str, Any]] = []  # structured og:image groups: an og:image starts one, its :alt/:width follow
    tw: list[str] = []
    tw_alt: str | None = None
    itemprop: list[str] = []
    for m in doc.iter("meta"):
        key = (m.get("property") or m.get("name") or "").strip().lower()
        content = m.get("content")
        if m.get("itemprop", "").strip().lower() == "image" and content:
            itemprop.append(content)
        if key in ("og:image", "og:image:url", "og:image:secure_url"):
            if key == "og:image" or not og:
                og.append({"url": content})
            elif not og[-1].get("url"):
                og[-1]["url"] = content
            elif key == "og:image:secure_url":
                og[-1]["url"] = content  # the https form of the same picture
        elif key == "og:image:alt" and og:
            og[-1].setdefault("alt", content)
        elif key == "og:image:width" and og:
            og[-1]["width"] = _int(content)
        elif key in ("twitter:image", "twitter:image:src") and content:
            tw.append(content)
        elif key == "twitter:image:alt":
            tw_alt = tw_alt or content

    found: dict[str, PageImage] = {}  # by URL, in order of preference

    def add(url: Any, alt: Any) -> None:
        u = _abs(base, url)
        if not u:
            return
        if u not in found:
            found[u] = PageImage(u, _clean_alt(alt))
        elif not found[u].alt:
            found[u].alt = _clean_alt(alt)  # the same picture named again, this time with its alt

    for g in og:
        if g.get("width") is not None and g["width"] < 300:
            continue
        add(g.get("url"), g.get("alt"))
    for u in tw:
        add(u, tw_alt)
    for s in doc.iter("script"):
        if (s.get("type") or "").strip().lower() != "application/ld+json":
            continue
        text = s.text or ""
        if not text.strip() or len(text) > MAX_JSONLD_BYTES:
            continue
        try:
            data = json.loads(text)
        except (ValueError, RecursionError):  # junk, or nesting deep enough to exhaust the parser
            continue
        for url, caption in _jsonld_images(data):
            add(url, caption)
    for u in itemprop:
        add(u, None)
    for lk in doc.iter("link"):
        if "image_src" in (lk.get("rel") or "").lower().split():
            add(lk.get("href"), None)
    return list(found.values())
