"""Pydantic models. The API models mirror web/lib/contracts.ts and docs/API.md field for field
(snake_case). The LLM models are the JSON schemas Claude must fill (draft-07 friendly)."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import quote

from pydantic import AfterValidator, BaseModel, ConfigDict, Field


def _safe_url(url: str) -> str:
    """Percent-encode non-ASCII and spaces so URLs are transport-safe; existing %XX escapes are kept."""
    return quote(url, safe=":/?&=#%+@!$,;'()*[]~-._")


SafeUrl = Annotated[str, AfterValidator(_safe_url)]


Slot = Literal["subh", "dopahar", "shaam"]
Route = Literal["direct", "germany"]
Tag = Literal["must-read", "worth-knowing", "skim"]
Coverage = Literal["broad", "partisan", "single-source"]
QaStatus = Literal["pending", "verified", "flagged"]
Platform = Literal["x", "bluesky", "telegram", "youtube"]


class _Lax(BaseModel):
    """Server responses may grow new fields; never fail on them."""

    model_config = ConfigDict(extra="ignore")


# ---- GET /api/worker/config -----------------------------------------------------------------
class EditionTimes(_Lax):
    subh: str = "07:00"
    dopahar: str = "13:00"
    shaam: str = "19:30"


class SiteSettings(_Lax):
    edition_times: EditionTimes = Field(default_factory=EditionTimes)
    timezone: str = "Asia/Karachi"
    publish_policy: Literal["auto", "hold"] = "auto"
    site_name_en: str = "Teen Pehr"
    site_name_ur: str = "تین پہر"
    editor_name: str = ""
    digits_ur: Literal["latn", "arabext"] = "latn"


class Group(_Lax):
    id: int
    slug: str
    name_en: str
    name_ur: str = ""
    order: int = 0
    brief: str = ""
    story_count: int = 7
    x_list_ids: list[str] = Field(default_factory=list)


class Source(_Lax):
    id: int
    group_id: int
    name: str
    kind: Literal["rss", "html", "gnews", "youtube", "telegram"] = "rss"
    url: str
    lang: str = "en"
    perspective: str = ""
    fetcher_tier: int = 0
    route: Route = "direct"
    max_items: int = 8
    fail_streak: int = 0


class Handle(_Lax):
    id: int
    group_id: int
    platform: Platform = "x"
    handle: str
    display_name: str = ""
    role: str = "journalist"
    last_post_at: datetime | None = None


class Topic(_Lax):
    group_id: int
    keywords_en: list[str] = Field(default_factory=list)
    keywords_ur: list[str] = Field(default_factory=list)
    boost: int = 1


class GlossaryEntry(_Lax):
    term_en: str
    term_ur: str
    kind: Literal["person", "place", "org", "other"] = "other"
    locked: bool = False


class Thread(_Lax):
    id: int
    slug: str
    title_en: str
    title_ur: str = ""
    last_seen: datetime | None = None


class Config(_Lax):
    settings: SiteSettings = Field(default_factory=SiteSettings)
    groups: list[Group] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    handles: list[Handle] = Field(default_factory=list)
    topics: list[Topic] = Field(default_factory=list)
    glossary: list[GlossaryEntry] = Field(default_factory=list)
    threads: list[Thread] = Field(default_factory=list)


# ---- runs ------------------------------------------------------------------------------------
class RunSourceResult(BaseModel):
    source_id: int
    ok: bool
    items: int = 0
    error: str | None = None
    ms: int = 0
    tier: int = 0
    route: Route = "direct"


class RunFinish(BaseModel):
    status: Literal["ok", "failed", "empty"]
    model: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    log: str = ""
    error: str | None = None
    sources: list[RunSourceResult] = Field(default_factory=list)


# ---- items / posts ----------------------------------------------------------------------------
class ItemIn(BaseModel):
    source_id: int
    url: SafeUrl
    url_canonical: str
    title: str
    text: str = ""
    published_at: datetime | None = None
    lang: str = "en"
    content_hash: str


class ItemOut(_Lax):
    url_canonical: str
    id: int
    is_new: bool = True


class ItemRecord(_Lax):
    id: int
    source_id: int
    url: str
    title: str
    text: str = ""
    published_at: datetime | None = None
    lang: str = "en"


class PostIn(BaseModel):
    platform: Platform = "x"
    platform_id: str
    author_handle: str
    author_name: str = ""
    text: str
    url: SafeUrl
    posted_at: datetime
    is_repost: bool = False
    raw: dict[str, Any] | None = None


class PostOut(_Lax):
    platform_id: str
    id: int
    is_new: bool = True
    handle_id: int | None = None


class PostRecord(_Lax):
    id: int
    handle_id: int | None = None
    author_handle: str
    author_name: str = ""
    text: str
    url: str
    posted_at: datetime
    is_repost: bool = False


# ---- editions --------------------------------------------------------------------------------
class AngleIn(BaseModel):
    item_id: int
    note_en: str
    note_ur: str = ""


class SourceRef(BaseModel):
    item_id: int
    is_primary: bool = False


class StoryIn(BaseModel):
    order: int
    thread: str | None = None
    thread_title_en: str | None = None
    thread_title_ur: str | None = None
    title_en: str
    title_ur: str = ""
    summary_en: str
    summary_ur: str = ""
    why_en: str = ""
    why_ur: str = ""
    tag: Tag = "worth-knowing"
    coverage: Coverage | None = None
    contested_en: str = ""
    contested_ur: str = ""
    angles: list[AngleIn] = Field(default_factory=list)
    sources: list[SourceRef]
    posts: list[int] = Field(default_factory=list)
    qa_status: QaStatus = "pending"
    qa_note: str = ""


class EditionGroupIn(BaseModel):
    group: str
    lead_en: str = ""
    lead_ur: str = ""
    item_count: int = 0
    stories: list[StoryIn]


class EditionIn(BaseModel):
    run_id: int | None = None
    status: Literal["draft", "review"] = "draft"
    groups: list[EditionGroupIn]


class EditionStoryOut(_Lax):
    order: int
    group: str
    id: int


class EditionOut(_Lax):
    edition_id: int
    status: str
    stories: list[EditionStoryOut] = Field(default_factory=list)


class PublishOut(_Lax):
    status: str
    flagged: int | None = None
    published_at: datetime | None = None
    url: str | None = None


# ---- LLM structured outputs -----------------------------------------------------------------
class LlmAngle(BaseModel):
    ref: int = Field(description="Item number whose framing this note describes")
    note: str = Field(description="How that outlet frames it, at most 12 words, not starting with the outlet name")


class LlmStory(BaseModel):
    ref: int = Field(description="The most informative and most neutral article item number")
    refs: list[int] = Field(description="Every article item number about this event, including ref")
    posts: list[int] = Field(default_factory=list, description="Post item numbers ([post]) that belong to this story")
    thread: str | None = Field(default=None, description="Slug of an existing thread this continues, else null")
    thread_title: str | None = Field(
        default=None, description="For a developing story with no existing thread: a short title for a new thread"
    )
    title: str = Field(description="Neutral title, at most 14 words, no loaded terms")
    summary: str = Field(description="2-3 sentences: facts the outlets agree on, with attribution for claims")
    why: str = Field(default="", description="One sentence: why it matters to the reader, or empty")
    tag: Tag = "worth-knowing"
    coverage: Coverage = "broad"
    contested: str = Field(default="", description="What the outlets dispute or leave out; empty if nothing")
    angles: list[LlmAngle] = Field(default_factory=list)


class CurateOut(BaseModel):
    lead: str = Field(description="One plain sentence, at most 22 words: the most important development right now")
    stories: list[LlmStory]


class LlmUrduStory(BaseModel):
    idx: int = Field(description="The story number from the input")
    title_ur: str
    summary_ur: str
    why_ur: str = ""
    contested_ur: str = ""
    angles_ur: list[str] = Field(default_factory=list, description="Urdu for each framing note, same order as input")


class LlmGlossaryAdd(BaseModel):
    term_en: str
    term_ur: str
    kind: Literal["person", "place", "org", "other"] = "other"


class UrduOut(BaseModel):
    lead_ur: str = ""
    stories: list[LlmUrduStory]
    glossary_additions: list[LlmGlossaryAdd] = Field(default_factory=list)


class LlmQaStory(BaseModel):
    n: int = Field(description="Story number from the input")
    status: Literal["verified", "flagged"]
    note: str = Field(default="", max_length=160, description="Problem in at most 160 characters; empty if verified")


class QaOut(BaseModel):
    stories: list[LlmQaStory]
