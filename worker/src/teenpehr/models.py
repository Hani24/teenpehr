"""Pydantic models. The API models mirror web/lib/contracts.ts and docs/API.md field for field
(snake_case). The LLM models are the JSON schemas Claude must fill (draft-07 friendly)."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, get_args
from urllib.parse import quote

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator


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
EntityKind = Literal["person", "org", "place", "event", "other"]

# Mirrors TOPICS and EVENT_TYPES in web/lib/taxonomy.ts (the edition PUT rejects any other slug).
# Slugs are stored, so never rename one; add new ones on both sides.
TopicSlug = Literal[
    "politics",
    "economy",
    "security",
    "diplomacy",
    "courts-law",
    "elections",
    "religion",
    "society",
    "human-rights",
    "health",
    "education",
    "climate-environment",
    "disaster",
    "energy",
    "technology",
    "business",
    "culture",
    "sport",
    "migration",
    "conflict",
]
EventType = Literal[
    "statement",
    "election",
    "protest",
    "attack",
    "court-ruling",
    "economic-data",
    "diplomatic-visit",
    "agreement",
    "disaster",
    "appointment",
    "legislation",
    "other",
]
TOPICS: tuple[str, ...] = get_args(TopicSlug)
EVENT_TYPES: tuple[str, ...] = get_args(EventType)
ENTITY_KINDS: tuple[str, ...] = get_args(EntityKind)


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
    site_name_en: str = "Tabayyun"
    site_name_ur: str = "تبیُّن"
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
    status: Literal["ok", "failed", "empty", "skipped"]
    model: str | None = None  # null when no Claude call succeeded
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    log: str = ""
    error: str | None = None
    sources: list[RunSourceResult] = Field(default_factory=list)


# ---- items / posts ----------------------------------------------------------------------------
class ItemFetch(BaseModel):
    """How an item was fetched (docs/API.md § POST /api/worker/items `fetch`)."""

    route: Route = "direct"
    tier: int = 1  # the curl_cffi fetcher
    status: int = 0
    ms: int = 0
    via: str = "rss"  # rss | gnews | youtube | article


class ItemIn(BaseModel):
    """None fields are left out of the request (api.py), so the server keeps them absent."""

    source_id: int
    url: SafeUrl
    url_canonical: str
    title: str
    text: str = ""
    published_at: datetime | None = None
    lang: str = "en"
    content_hash: str
    # Research metadata (decision D5), written by the server only when it first stores the item.
    author: str | None = None
    categories: list[str] = Field(default_factory=list)
    image_url: str | None = None
    description: str | None = None
    word_count: int | None = None
    lang_detected: str | None = None
    guid: str | None = None
    feed_updated_at: datetime | None = None
    site_name: str | None = None
    fetch: ItemFetch | None = None
    raw: dict[str, Any] | None = None


class StoredItem(_Lax):
    """An existing item as the server first stored it (never rewritten: stories cite this text)."""

    title: str
    text: str = ""
    published_at: datetime | None = None


class ItemOut(_Lax):
    url_canonical: str
    id: int
    is_new: bool = True
    stored: StoredItem | None = None  # set when the item existed before this request


class ItemRecord(_Lax):
    id: int
    source_id: int
    url: str
    url_canonical: str | None = None  # absent from web apps older than D5
    content_hash: str | None = None
    title: str
    text: str = ""
    published_at: datetime | None = None
    lang: str = "en"
    image_url: str | None = None  # the stored lead image, when the web app sends it (story images, D6)


class PostMetrics(BaseModel):
    """Counts as the platform reported them when collected; a count the platform did not give is None."""

    replies: int | None = None
    reposts: int | None = None
    likes: int | None = None
    quotes: int | None = None
    views: int | None = None
    bookmarks: int | None = None


class PostMedia(BaseModel):
    type: Literal["photo", "video", "gif", "other"] = "other"
    url: str
    preview_url: str | None = None
    alt: str | None = None


class PostIn(BaseModel):
    """None fields are left out of the request (api.py): the server leaves what it has stored alone."""

    platform: Platform = "x"
    platform_id: str
    author_handle: str
    author_name: str = ""
    text: str
    url: SafeUrl
    posted_at: datetime
    is_repost: bool = False
    raw: dict[str, Any] | None = None
    lang: str | None = None
    metrics: PostMetrics | None = None
    hashtags: list[str] | None = None
    mentions: list[str] | None = None
    urls: list[str] | None = None
    media: list[PostMedia] | None = None
    in_reply_to: str | None = None
    conversation_id: str | None = None


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
    # The post's media, when the web app sends it: a cited post's first photo can be the story's image (D6).
    media: list[PostMedia] | None = None

    @field_validator("media", mode="before")
    @classmethod
    def _media(cls, v: Any) -> Any:
        """Entries that do not parse are dropped, never a failed read of the posts."""
        if not isinstance(v, list):
            return None
        out = []
        for m in v:
            try:
                out.append(PostMedia.model_validate(m))
            except ValueError:
                continue
        return out


# ---- editions --------------------------------------------------------------------------------
class AngleIn(BaseModel):
    item_id: int
    note_en: str
    note_ur: str = ""


class SourceRef(BaseModel):
    item_id: int
    is_primary: bool = False


class EntityIn(BaseModel):
    name_en: str
    name_ur: str = ""
    kind: EntityKind = "other"
    role: str = ""
    salience: float = 0.5  # 0-1 (the API refuses null here)


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
    # Research metadata from curation (D5). Checked against the cited items in pipeline.py.
    keywords: list[str] = Field(default_factory=list)
    topics: list[TopicSlug] = Field(default_factory=list)
    countries: list[str] = Field(default_factory=list)  # ISO 3166-1 alpha-2, upper case
    places: list[str] = Field(default_factory=list)
    event_type: EventType | None = None
    entities: list[EntityIn] = Field(default_factory=list)
    # POST /api/worker/images id of the publisher image of an item or post this story cites (D6)
    image_id: int | None = None


class EditionGroupIn(BaseModel):
    group: str
    lead_en: str = ""
    lead_ur: str = ""
    item_count: int = 0
    stories: list[StoryIn]


class EditionIn(BaseModel):
    run_id: int | None = None
    status: Literal["draft", "review"] = "draft"
    # true: the server replaces only the groups in this payload and keeps the draft's other groups
    partial: bool = False
    groups: list[EditionGroupIn]


class EditionStoryOut(_Lax):
    order: int
    group: str
    id: int


class EditionOut(_Lax):
    edition_id: int
    status: str
    stories: list[EditionStoryOut] = Field(default_factory=list)


class EditionState(_Lax):
    """GET /api/worker/editions/{date}/{slot}: where an existing edition stands."""

    edition_id: int
    status: str  # "draft" | "review" | "published"; the run acts only on the last two
    groups: list[str] = Field(default_factory=list)


class RunOutputIn(BaseModel):
    """One Claude call's structured output (POST /api/worker/runs/{id}/outputs)."""

    group: str | None = None  # group slug; None for a call that covers every group
    # "image": one story image's vision-check outcome (D6), answered or not, so a blurred or dropped picture
    # can be explained later
    stage: Literal["curate", "urdu", "qa", "image"]
    model: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    output: dict[str, Any]


class PublishOut(_Lax):
    status: str
    flagged: int | None = None
    published_at: datetime | None = None
    url: str | None = None


# ---- POST /api/worker/images (docs/API.md, decision D6) -------------------------------------------
class ImageVariantIn(BaseModel):
    w: int
    h: int
    mime: Literal["image/webp"] = "image/webp"
    data_base64: str


class ImageIn(BaseModel):
    """One publisher image of an item or post a story cites. `alt` is the publisher's own text or None,
    never a model's; `graphic` is true whenever the vision check failed or did not run (fail safe)."""

    sha256: str  # of the bytes as downloaded
    source_url: str
    item_id: int | None = None
    post_id: int | None = None
    source_id: int | None = None  # the feed that carried the item (items only)
    credit: str
    alt: str | None = None
    graphic: bool = True
    color: str  # "#rrggbb"
    width: int  # the original's size after EXIF orientation
    height: int
    variants: list[ImageVariantIn]


class ImageOut(_Lax):
    image_id: int
    created: bool = True


# ---- LLM structured outputs -----------------------------------------------------------------
class LlmAngle(BaseModel):
    ref: int = Field(description="Item number whose framing this note describes")
    note: str = Field(description="How that outlet frames it, at most 12 words, not starting with the outlet name")


class LlmEntity(BaseModel):
    name: str = Field(description="The name exactly as written in the cited items (English), e.g. 'Shehbaz Sharif'")
    kind: EntityKind = "other"
    role: str = Field(default="", description="What it is in this story, 1-3 words (e.g. 'prime minister', 'lender')")
    salience: float = Field(default=0.5, description="0-1: how central it is to the story")

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, v: Any) -> Any:
        return v if v in ENTITY_KINDS else "other"


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
    keywords: list[str] = Field(default_factory=list, description="Up to 8 search keywords taken from the items")
    topics: list[TopicSlug] = Field(default_factory=list, description="1-3 topics")
    countries: list[str] = Field(default_factory=list, description="ISO 3166-1 alpha-2 codes of countries involved")
    places: list[str] = Field(default_factory=list, description="Cities, provinces or regions named in the items")
    event_type: EventType | None = None
    entities: list[LlmEntity] = Field(default_factory=list, description="Up to 6 people, organisations, places, events")

    # The schema offers only the known slugs; should the model still send another, it is dropped here
    # rather than failing the whole curation call.
    @field_validator("topics", mode="before")
    @classmethod
    def _topics(cls, v: Any) -> Any:
        return [x for x in v if x in TOPICS] if isinstance(v, list) else []

    @field_validator("event_type", mode="before")
    @classmethod
    def _event_type(cls, v: Any) -> Any:
        return v if v in EVENT_TYPES else None


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
    thread_title_ur: str = Field(
        default="", description="Urdu for the story's thread title when the input gives one, else empty"
    )
    entities_ur: list[str] = Field(
        default_factory=list, description="Urdu spelling of each name in the story's Entities line, same order"
    )


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
    # No max_length: one long note must not fail the whole QA call (and leave every story unchecked).
    # The pipeline trims it instead.
    note: str = Field(default="", description="Problem in at most 160 characters; empty if verified")


class QaOut(BaseModel):
    stories: list[LlmQaStory]


class ImageCheckOut(BaseModel):
    """The vision check's verdict on one publisher image (prompts/image_check.md)."""

    graphic: bool = Field(description="True if it shows blood, gore, dead or badly injured people, or violence")
    placeholder_or_logo: bool = Field(
        description="True if it is a logo, a site's default or placeholder image, a text card, an advert or blank"
    )
