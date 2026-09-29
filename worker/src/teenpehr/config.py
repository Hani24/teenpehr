"""Environment configuration. Values come from the process environment or a `.env` file in
the working directory (worker/). Secrets are never logged."""

from __future__ import annotations

from pathlib import Path

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    site_url: str = "http://localhost:3000"
    worker_token: str = ""

    # Claude access (docs/PLAN.md, billing row): every model call goes through claude-agent-sdk, which
    # runs the Claude Code CLI signed in on this machine (~/.claude, a Claude subscription). Never an
    # API key. A long-lived token from `claude setup-token` may be set instead of the interactive login;
    # llm.ClaudeLLM hands it to the CLI as CLAUDE_CODE_OAUTH_TOKEN.
    claude_code_oauth_token: SecretStr | None = None
    # Read only to warn that it is ignored: the CLI would bill an API key over the login, so llm.py
    # strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from what the CLI sees.
    stray_api_key: SecretStr | None = Field(
        default=None, validation_alias=AliasChoices("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
    )

    news_model_curate: str = "claude-sonnet-5"
    news_model_urdu: str = "claude-opus-5-5"
    news_model_qa: str = "claude-haiku-4-5-20251001"
    # Ceilings per Claude call, in API-equivalent dollars (the CLI prices each call's tokens at API list
    # prices; on a subscription nothing is billed per call, but the numbers still bound usage).
    budget_curate_usd: float = 1.0
    budget_urdu_usd: float = 1.5
    budget_qa_usd: float = 0.5
    # Claude effort per pass (None = model default). QA is a checklist, so low effort is enough.
    effort_curate: str | None = None
    effort_urdu: str | None = None
    effort_qa: str | None = "low"
    # Usage ceiling per day in API-equivalent dollars (decision D13: 12): a run is skipped once today's total
    # reaches it. Jobs (full-article translations, manual-story fills) count toward it too.
    daily_budget_usd: float = 12.0

    # Publisher images (docs/PLAN.md D6). IMAGES=0 turns the whole feature off; IMAGE_CHECK=0 skips the
    # vision check, and then every image is sent as graphic (blurred) unless IMAGES_TRUST_UNCHECKED=1.
    images: bool = True
    image_check: bool = True
    images_trust_unchecked: bool = False
    news_model_image_check: str | None = None  # default: NEWS_MODEL_QA (Haiku 4.5)
    budget_image_check_usd: float = 0.05
    image_page_fetch_limit: int = 40  # article pages fetched per run only to find an image (og:image)
    # Wall-clock limit on the whole image step: past it no new page read or download starts, and the
    # stories still waiting get no image (the run and its unit's time limit matter more than pictures).
    image_time_limit_s: float = 600.0

    # Jobs the site queues between editions (`teenpehr jobs`, docs/API.md § Jobs; decisions D9 and D12).
    # Full-article Urdu translations (D9): the Urdu model translates, the QA model checks faithfulness.
    news_model_translate: str | None = None  # default: NEWS_MODEL_URDU
    news_model_translate_check: str | None = None  # default: NEWS_MODEL_QA
    news_model_fill: str | None = None  # a manual story's missing side; default: Urdu model for ur, curate model for en
    budget_translate_usd: float = 1.0  # per translation call (one chunk of about TRANSLATE_CHUNK_WORDS)
    budget_translate_check_usd: float = 0.3  # per faithfulness check
    budget_fill_usd: float = 0.5
    translate_max_usd: float = 3.0  # one article, every call included: past it the job fails rather than spend more
    effort_translate: str | None = None
    translate_chunk_words: int = 900
    translate_min_words: int = 60  # less text than this is a teaser, a video page or a paywall stub
    translate_max_words: int = 8000  # longer articles are refused as too_long
    translate_repair: bool = True  # retranslate the paragraphs the first check flags, once
    jobs_poll_s: float = 3.0  # idle wait between claims
    jobs_lease_s: int = 1800  # a long article takes several minutes; 60-3600
    jobs_concurrency: int = 1  # jobs at a time
    jobs_stop_grace_s: float = 120.0  # on SIGINT/SIGTERM, how long the current job may take to finish
    # While the edition run (news-worker.service) is active, jobs that fetch from publishers wait, so two
    # processes never read one host at the same time and the edition gets the machine first.
    jobs_pause_during_editions: bool = True

    germany_proxy: str = "socks5h://127.0.0.1:1080"
    dry_run: bool = False
    ntfy_topic: str = ""
    ntfy_on_success: bool = False
    out_dir: Path = Path("out")
    lookback_hours: float | None = Field(default=None, description="Override the computed window")
    overlap_hours: float = 2.0
    backfill_after_hours: float = 2.0
    tz: str = "Asia/Karachi"

    twitterapi_io_key: str | None = None
    x_list_spacing_s: float = 5.0
    x_stale_hours: float = 24.0
    bluesky_spacing_s: float = 1.0  # between two watched Bluesky accounts in collect-x (D10)
    bluesky_posts_per_handle: int = 30
    article_fetch_limit: int = 150  # D11: headline-only sitemap and Google News items share it
    fetch_timeout_s: float = 25.0
    fetch_workers: int = 8
    prompt_item_chars: int = 400

    @property
    def state_dir(self) -> Path:
        return self.out_dir / "state"

    @property
    def has_stray_api_key(self) -> bool:
        """An API key is set (and ignored): worth a warning, since it is not what the worker uses."""
        return bool(self.stray_api_key and self.stray_api_key.get_secret_value().strip())

    @property
    def image_check_model(self) -> str:
        return self.news_model_image_check or self.news_model_qa

    @property
    def translate_model(self) -> str:
        return self.news_model_translate or self.news_model_urdu

    @property
    def translate_check_model(self) -> str:
        return self.news_model_translate_check or self.news_model_qa

    def fill_model(self, lang: str) -> str:
        return self.news_model_fill or (self.news_model_urdu if lang == "ur" else self.news_model_curate)


def load() -> Settings:
    s = Settings()
    s.out_dir.mkdir(parents=True, exist_ok=True)
    s.state_dir.mkdir(parents=True, exist_ok=True)
    return s
