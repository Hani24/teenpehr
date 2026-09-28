from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from teenpehr.config import Settings

FIXTURES = Path(__file__).parent / "fixtures"


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def fixture_text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    s = Settings(
        _env_file=None,
        site_url="http://web.test",
        worker_token="test-token",
        out_dir=tmp_path / "out",
        ntfy_topic="",
        article_fetch_limit=5,
        images=False,  # the image step has its own tests (test_images*.py), which turn it on
    )
    s.out_dir.mkdir(parents=True, exist_ok=True)
    s.state_dir.mkdir(parents=True, exist_ok=True)
    return s


NOW = datetime(2026, 9, 23, 8, 5, tzinfo=UTC)  # 13:05 Karachi

CONFIG = {
    "settings": {
        "edition_times": {"subh": "07:00", "dopahar": "13:00", "shaam": "19:30"},
        "timezone": "Asia/Karachi",
        "publish_policy": "auto",
        "site_name_en": "Tabayyun",
        "digits_ur": "latn",
        "editor_name": "",
    },
    "groups": [
        {
            "id": 1,
            "slug": "pakistan",
            "name_en": "Pakistan",
            "name_ur": "پاکستان",
            "order": 0,
            "brief": "PK brief",
            "story_count": 5,
            "x_list_ids": ["84839422"],
        },
        {
            "id": 2,
            "slug": "india",
            "name_en": "India",
            "name_ur": "بھارت",
            "order": 1,
            "brief": "IN brief",
            "story_count": 3,
            "x_list_ids": [],
        },
    ],
    "sources": [
        {
            "id": 10,
            "group_id": 1,
            "name": "Jang",
            "kind": "rss",
            "url": "https://jang.test/rss",
            "lang": "ur",
            "perspective": "Largest Urdu daily",
            "route": "direct",
            "max_items": 8,
        },
        {
            "id": 11,
            "group_id": 1,
            "name": "Geo",
            "kind": "rss",
            "url": "https://geo.test/rss",
            "lang": "en",
            "perspective": "Jang group TV",
            "route": "direct",
            "max_items": 8,
        },
        {
            "id": 12,
            "group_id": 2,
            "name": "Amu",
            "kind": "rss",
            "url": "https://amu.test/feed",
            "lang": "en",
            "perspective": "exile",
            "route": "germany",
            "max_items": 8,
        },
        {
            "id": 13,
            "group_id": 2,
            "name": "Broken",
            "kind": "rss",
            "url": "https://broken.test/feed",
            "lang": "en",
            "route": "direct",
            "max_items": 8,
        },
    ],
    "handles": [
        {
            "id": 5,
            "group_id": 1,
            "platform": "x",
            "handle": "HamidMirPAK",
            "display_name": "Hamid Mir",
            "role": "journalist",
        },
        {"id": 6, "group_id": 1, "platform": "x", "handle": "Movies", "display_name": "Movies", "role": "outlet"},
    ],
    "topics": [],
    "glossary": [{"term_en": "Shehbaz Sharif", "term_ur": "شہباز شریف", "kind": "person", "locked": True}],
    "threads": [
        {
            "id": 3,
            "slug": "imf-review-2026-09",
            "title_en": "IMF review",
            "title_ur": "",
            "last_seen": "2026-09-22T10:00:00+00:00",
        }
    ],
}


def config_json() -> str:
    return json.dumps(CONFIG)
