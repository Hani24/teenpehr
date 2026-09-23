"""URL canonicalisation, dedupe keys, content hashes and Urdu text normalisation."""

from __future__ import annotations

import hashlib
import re
from urllib.parse import parse_qsl, urlencode, urlsplit

_TRACKING_EXACT = {
    "fbclid",
    "gclid",
    "dclid",
    "msclkid",
    "igshid",
    "mc_cid",
    "mc_eid",
    "ncid",
    "cmpid",
    "ocid",
    "ref",
    "ref_src",
    "ref_url",
    "referrer",
    "source",
    "src",
    "s",
    "si",
    "spm",
    "yclid",
    "_ga",
    "amp",
    "output",
    "rss",
    "feed",
    "cid",
}
_TRACKING_PREFIX = ("utm_", "pk_", "mtm_", "hsa_", "vero_", "ic_", "at_")

GNEWS_HOST = "news.google.com"


def is_gnews(url: str) -> bool:
    return GNEWS_HOST in url


def canonical_url(url: str) -> str:
    """Stable key for one article across feeds: host without www, path without trailing slash,
    only non-tracking query params (sorted), no scheme or fragment. Lower-cases host only."""
    p = urlsplit(url.strip())
    host = (p.hostname or "").lower()
    host = host.removeprefix("www.").removeprefix("m.").removeprefix("amp.")
    path = re.sub(r"/{2,}", "/", p.path or "")
    path = re.sub(r"/(amp|index\.html?)$", "", path)
    if path.endswith("/") and len(path) > 1:
        path = path.rstrip("/")
    if path == "/":
        path = ""
    params = [
        (k, v)
        for k, v in parse_qsl(p.query, keep_blank_values=False)
        if not (k.lower() in _TRACKING_EXACT or k.lower().startswith(_TRACKING_PREFIX))
    ]
    query = urlencode(sorted(params)) if params else ""
    return f"{host}{path}" + (f"?{query}" if query else "")


def title_key(title: str) -> str:
    return re.sub(r"\W+", " ", title.lower()).strip()


def content_hash(url_canonical: str, title: str) -> str:
    return hashlib.sha256(f"{url_canonical}\n{title_key(title)}".encode()).hexdigest()


def strip_outlet_suffix(title: str) -> str:
    """Google News titles end with ' - Outlet Name'."""
    return re.sub(r"\s+[-–|]\s+[^-–|]{2,60}$", "", title).strip()


# ---- Urdu --------------------------------------------------------------------------------------
_URDU_MAP = str.maketrans(
    {
        "\u064a": "\u06cc",  # ARABIC YEH -> FARSI YEH
        "\u0649": "\u06cc",  # ALEF MAKSURA -> FARSI YEH
        "\u0643": "\u06a9",  # ARABIC KAF -> KEHEH
        "\u0647": "\u06c1",  # ARABIC HEH -> HEH GOAL
        "\u0629": "\u06c3",  # TEH MARBUTA -> TEH MARBUTA GOAL
        "\u0671": "\u0627",  # ALEF WASLA -> ALEF
        "\u06c0": "\u06c2",  # HEH WITH YEH ABOVE -> HEH GOAL WITH HAMZA
    }
)
_ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩"
_EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹"
_TO_LATN = str.maketrans(_ARABIC_INDIC + _EXT_ARABIC_INDIC, "0123456789" * 2)
_TO_ARABEXT = str.maketrans("0123456789" + _ARABIC_INDIC, _EXT_ARABIC_INDIC * 2)


def normalize_urdu(text: str, digits: str = "keep") -> str:
    """Map Arabic-script code points to the Urdu forms every recommended font shapes correctly
    (ی U+06CC, ک U+06A9, ہ U+06C1, ۃ U+06C3) and optionally unify digits.

    `digits`: "keep" leaves digits alone, "latn" forces 0-9, "arabext" forces ۰-۹."""
    out = text.translate(_URDU_MAP)
    if digits == "latn":
        out = out.translate(_TO_LATN)
    elif digits == "arabext":
        out = out.translate(_TO_ARABEXT)
    out = re.sub(r"[ \t]+", " ", out)
    return out.strip()


def slugify(text: str, max_len: int = 60) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:max_len].rstrip("-") or "story"
