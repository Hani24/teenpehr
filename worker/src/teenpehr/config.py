"""Environment configuration. Values come from the process environment or a `.env` file in
the working directory (worker/). Secrets are never logged."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    site_url: str = "http://localhost:3000"
    worker_token: str = ""
    anthropic_api_key: str | None = None

    news_model_curate: str = "claude-sonnet-5"
    news_model_urdu: str = "claude-opus-5-5"
    news_model_qa: str = "claude-haiku-4-5-20251001"
    budget_curate_usd: float = 1.0
    budget_urdu_usd: float = 1.5
    budget_qa_usd: float = 0.5
    # Claude effort per pass (None = model default). QA is a checklist, so low effort is enough.
    effort_curate: str | None = None
    effort_urdu: str | None = None
    effort_qa: str | None = "low"
    daily_budget_usd: float = 6.0

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


def load() -> Settings:
    s = Settings()
    s.out_dir.mkdir(parents=True, exist_ok=True)
    s.state_dir.mkdir(parents=True, exist_ok=True)
    return s
