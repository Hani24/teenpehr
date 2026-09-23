"""Logging to stderr with a compact key=value style. Secrets never go through here."""

from __future__ import annotations

import logging
import sys

_FMT = "%(asctime)s %(levelname)-5s %(name)s: %(message)s"


def setup(level: str = "INFO") -> None:
    """Configure the root logger once (idempotent)."""
    root = logging.getLogger()
    if root.handlers:
        root.setLevel(level)
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(_FMT, datefmt="%H:%M:%S"))
    root.addHandler(handler)
    root.setLevel(level)
    for noisy in ("httpx", "httpcore", "trafilatura", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get(name: str) -> logging.Logger:
    return logging.getLogger(f"teenpehr.{name}")
