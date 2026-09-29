"""What every job handler shares: typed views of GET /jobs/{id}/context, the two outcomes a handler
returns (Done or Failed), the job's Claude usage, and the environment it runs in.

Everything in a context (an article's metadata, an editor's story text) is data for a prompt, never
instructions, and is quoted as data wherever it reaches Claude."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..llm import LLMError, LLMResult
from ..models import JobResult, TranslationBlockReason

if TYPE_CHECKING:
    from ..api import WorkerApi
    from ..config import Settings
    from ..fetch.http import Fetcher
    from ..llm import LLM
    from .fulltext import FullTextFetcher


class _Lax(BaseModel):
    model_config = ConfigDict(extra="ignore")


class SourceCtx(_Lax):
    id: int
    name: str = ""
    kind: str = "rss"
    route: str = "direct"
    lang: str = "en"
    url: str = ""
    perspective: str = ""
    fetcher_tier: int = 0

    @field_validator("route", mode="before")
    @classmethod
    def _route(cls, v: Any) -> str:
        return v if v in ("direct", "germany") else "direct"

    @field_validator("name", "kind", "lang", "url", "perspective", mode="before")
    @classmethod
    def _text(cls, v: Any) -> Any:
        return "" if v is None else v


class ItemCtx(_Lax):
    """A cited item as a job sees it: where to fetch it (its source's route) and whose it is."""

    id: int
    url: str
    url_canonical: str | None = None
    title: str = ""
    lang: str = "en"
    published_at: datetime | None = None
    description: str | None = None
    image_url: str | None = None
    site_name: str | None = None
    author: str | None = None
    source: SourceCtx
    is_primary: bool = False

    @field_validator("title", "lang", mode="before")
    @classmethod
    def _text(cls, v: Any) -> Any:
        return "" if v is None else v

    @property
    def outlet(self) -> str:
        """The outlet's name as readers know it: the page's own site name for a manual link or a Google
        News item, else the feed's name."""
        if self.site_name and self.source.kind in ("manual", "gnews"):
            return self.site_name
        return self.source.name or self.site_name or ""


class GroupCtx(_Lax):
    slug: str = ""
    name_en: str = ""
    name_ur: str = ""


STORY_FIELDS = ("title", "summary", "why", "contested")


class StoryCtx(_Lax):
    id: int
    origin: str = "ai"
    placement: str | None = None
    tag: str = "worth-knowing"
    title_en: str = ""
    title_ur: str = ""
    summary_en: str = ""
    summary_ur: str = ""
    why_en: str = ""
    why_ur: str = ""
    contested_en: str = ""
    contested_ur: str = ""
    language_filled: str | None = None
    created_by_name: str = ""
    image_id: int | None = None
    desk_at: datetime | None = None
    edition_status: str = "draft"
    group: GroupCtx = Field(default_factory=GroupCtx)

    @field_validator(
        "title_en",
        "title_ur",
        "summary_en",
        "summary_ur",
        "why_en",
        "why_ur",
        "contested_en",
        "contested_ur",
        "created_by_name",
        mode="before",
    )
    @classmethod
    def _text(cls, v: Any) -> Any:
        return "" if v is None else v

    @property
    def live(self) -> bool:
        """Published, or live on the Editor's desk: never edited again."""
        return self.desk_at is not None or self.edition_status == "published"

    def side(self, lang: str) -> dict[str, str]:
        return {f: str(getattr(self, f"{f}_{lang}") or "").strip() for f in STORY_FIELDS}


class TranslationCtx(_Lax):
    status: str | None = None
    source_text_hash: str | None = None
    finished_at: datetime | None = None


class JobError(RuntimeError):
    """A handler problem that should end the job as failed; `retry` asks for another attempt later."""

    def __init__(self, message: str, *, retry: bool = True, retry_after_s: int | None = None):
        super().__init__(message)
        self.retry = retry
        self.retry_after_s = retry_after_s


class BudgetReached(JobError):
    """Today's usage ceiling was reached in the middle of a job: it waits for tomorrow."""


@dataclass
class Done:
    result: JobResult
    summary: str = ""


@dataclass
class Failed:
    error: str
    retry: bool = False
    blocked: bool = False
    reason: TranslationBlockReason | None = None
    retry_after_s: int | None = None


Outcome = Done | Failed


@dataclass
class Usage:
    """A job's Claude calls: API-equivalent dollars and tokens (they count toward DAILY_BUDGET_USD)."""

    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    calls: int = 0
    models: list[str] = field(default_factory=list)

    def add(self, res: LLMResult) -> None:
        self.cost_usd += res.cost_usd
        self.tokens_in += res.tokens_in
        self.tokens_out += res.tokens_out
        self.calls += 1
        if res.model and res.model not in self.models:
            self.models.append(res.model)

    def add_failure(self, e: LLMError) -> None:
        self.cost_usd += e.cost_usd or 0.0
        self.calls += 1

    def fields(self, model: str | None = None) -> dict[str, Any]:
        """The usage fields of a job result."""
        return {
            "model": (model or (self.models[0] if self.models else ""))[:100],
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "cost_usd": round(self.cost_usd, 6),
        }


@dataclass
class JobEnv:
    """What a handler may use. `budget_ok()` says whether today's ceiling still allows another Claude
    call, this job's usage so far included."""

    settings: Settings
    api: WorkerApi
    llm: LLM
    fetcher: Fetcher
    fulltext: FullTextFetcher
    usage: Usage
    budget_ok: Callable[[], bool]
