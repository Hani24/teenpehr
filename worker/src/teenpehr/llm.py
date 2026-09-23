"""Claude calls through the Claude Agent SDK, always with a JSON-schema structured output and no
tools. `FakeLLM` stands in for tests. Prompts live in worker/prompts/*.md as $var templates."""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from string import Template
from typing import Any, Protocol, TypeVar

from pydantic import BaseModel, ValidationError

from . import log

logger = log.get("llm")
T = TypeVar("T", bound=BaseModel)

PROMPTS_DIR = Path(os.environ.get("PROMPTS_DIR") or Path(__file__).resolve().parents[2] / "prompts")


class LLMError(RuntimeError):
    pass


@dataclass
class LLMResult[T]:
    output: T
    model: str
    cost_usd: float = 0.0
    tokens_in: int = 0  # uncached + cache_read + cache_write, summed over the query's API turns
    tokens_out: int = 0
    duration_s: float = 0.0
    uncached: int = 0
    cache_read: int = 0
    cache_write: int = 0


def load_prompt(name: str, **vars: Any) -> str:
    text = (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8")
    return Template(text).safe_substitute({k: str(v) for k, v in vars.items()})


class LLM(Protocol):
    async def structured(
        self,
        *,
        task: str,
        system: str,
        user: str,
        schema: type[T],
        model: str,
        max_budget_usd: float,
        effort: str | None = None,
    ) -> LLMResult[T]: ...


class ClaudeLLM:
    """One `query()` per call: no tools, no filesystem settings, no session persistence."""

    def __init__(self, *, cwd: Path | None = None, max_turns: int = 3, concurrency: int = 3, effort: str | None = None):
        self.cwd = cwd
        self.max_turns = max_turns
        self.effort = effort
        self._sem = asyncio.Semaphore(concurrency)

    async def structured(
        self,
        *,
        task: str,
        system: str,
        user: str,
        schema: type[T],
        model: str,
        max_budget_usd: float,
        effort: str | None = None,
    ) -> LLMResult[T]:
        from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

        options = ClaudeAgentOptions(
            model=model,
            system_prompt=system,
            tools=[],
            disallowed_tools=["WebSearch", "WebFetch", "Bash", "Edit", "Write", "Task", "Agent"],
            permission_mode="dontAsk",
            setting_sources=[],
            max_turns=self.max_turns,
            max_budget_usd=max_budget_usd,
            output_format={"type": "json_schema", "schema": schema.model_json_schema()},
            extra_args={"no-session-persistence": None},
            cwd=str(self.cwd) if self.cwd else None,
            effort=effort or self.effort,  # type: ignore[arg-type]
        )
        t0 = time.monotonic()
        result: ResultMessage | None = None
        async with self._sem:
            try:
                async for message in query(prompt=user, options=options):
                    if isinstance(message, ResultMessage):
                        result = message
            except Exception as e:  # noqa: BLE001 - SDK raises after yielding an error result
                if result is None:
                    raise LLMError(f"{task}: {type(e).__name__}: {str(e)[:300]}") from e
        if result is None:
            raise LLMError(f"{task}: no result message")
        if result.subtype != "success" or not result.structured_output:
            errs = getattr(result, "errors", None)
            raise LLMError(f"{task}: {result.subtype} {errs or ''} {str(result.result or '')[:200]}".strip())
        try:
            output = schema.model_validate(result.structured_output)
        except ValidationError as e:
            raise LLMError(f"{task}: output failed validation: {str(e)[:300]}") from e
        tok = usage_tokens(result.usage, result.model_usage)
        res = LLMResult(
            output=output,
            model=model,
            cost_usd=float(result.total_cost_usd or 0.0),
            tokens_in=tok["in"],
            tokens_out=tok["out"],
            duration_s=round(time.monotonic() - t0, 1),
            uncached=tok["input"],
            cache_read=tok["cache_read"],
            cache_write=tok["cache_write"],
        )
        logger.info(
            "%s: %s in %.1fs, $%.4f, tokens in=%d (uncached=%d cache_read=%d cache_write=%d) out=%d, prompt=%d chars",
            task,
            model,
            res.duration_s,
            res.cost_usd,
            tok["in"],
            tok["input"],
            tok["cache_read"],
            tok["cache_write"],
            tok["out"],
            len(system) + len(user),
        )
        return res


def usage_tokens(usage: Any, model_usage: Any) -> dict[str, int]:
    """Sum token counts from the result's `usage` (snake_case) or, failing that, from the per-model
    `model_usage` map (camelCase, passed through from the CLI). `in` = uncached + cache read + cache write."""

    def pick(d: Any, *keys: str) -> int:
        if d is None:
            return 0
        for k in keys:
            v = d.get(k) if isinstance(d, dict) else getattr(d, k, None)
            if v:
                return int(v)
        return 0

    inp = pick(usage, "input_tokens", "inputTokens")
    out = pick(usage, "output_tokens", "outputTokens")
    cr = pick(usage, "cache_read_input_tokens", "cacheReadInputTokens")
    cw = pick(usage, "cache_creation_input_tokens", "cacheCreationInputTokens")
    if not (inp or out or cr or cw) and isinstance(model_usage, dict):
        for mu in model_usage.values():
            inp += pick(mu, "inputTokens", "input_tokens")
            out += pick(mu, "outputTokens", "output_tokens")
            cr += pick(mu, "cacheReadInputTokens", "cache_read_input_tokens")
            cw += pick(mu, "cacheCreationInputTokens", "cache_creation_input_tokens")
    return {"input": inp, "cache_read": cr, "cache_write": cw, "in": inp + cr + cw, "out": out}


@dataclass
class FakeLLM:
    """Test double: `responses[task]` is an output instance or a callable(user_text) -> instance."""

    responses: dict[str, Any] = field(default_factory=dict)
    calls: list[dict[str, Any]] = field(default_factory=list)
    cost_per_call: float = 0.01

    async def structured(
        self,
        *,
        task: str,
        system: str,
        user: str,
        schema: type[T],
        model: str,
        max_budget_usd: float,
        effort: str | None = None,
    ) -> LLMResult[T]:
        self.calls.append({"task": task, "system": system, "user": user, "model": model, "schema": schema.__name__})
        r = self.responses.get(task)
        if r is None:
            raise LLMError(f"{task}: no fake response configured")
        if isinstance(r, Exception):
            raise r
        out = r(user) if isinstance(r, Callable) else r
        if isinstance(out, dict):
            out = schema.model_validate(out)
        return LLMResult(
            output=out,
            model=model,
            cost_usd=self.cost_per_call,
            tokens_in=1000,
            tokens_out=200,
            uncached=10,
            cache_read=490,
            cache_write=500,
        )
