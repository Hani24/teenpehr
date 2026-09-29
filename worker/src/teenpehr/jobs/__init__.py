"""Work the site asks of the worker between editions (docs/API.md § Jobs): full-article Urdu translations
readers request (D9), and a manual story's missing language and image (D12). `teenpehr jobs` runs
runner.JobRunner; each kind has its handler module."""

from .runner import ALL_KINDS, JobReport, JobRunner, RunnerReport, default_worker_id

__all__ = ["ALL_KINDS", "JobReport", "JobRunner", "RunnerReport", "default_worker_id"]
