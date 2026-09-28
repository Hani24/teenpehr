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
    # Usage ceiling per day in API-equivalent dollars: a run is skipped once today's total reaches it.
    daily_budget_usd: float = 6.0

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
    article_fetch_limit: int = 60
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


def load() -> Settings:
    s = Settings()
    s.out_dir.mkdir(parents=True, exist_ok=True)
    s.state_dir.mkdir(parents=True, exist_ok=True)
    return s
