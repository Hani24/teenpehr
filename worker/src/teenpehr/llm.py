"""Claude calls through the Claude Agent SDK, always with a JSON-schema structured output and no
tools. `FakeLLM` stands in for tests. Prompts live in worker/prompts/*.md as $var templates.

Claude access (docs/PLAN.md, billing row): the SDK drives the Claude Code CLI, and the CLI uses its
own sign-in on this machine (`~/.claude`, the owner's Claude subscription), or a long-lived token
from `claude setup-token` passed as CLAUDE_CODE_OAUTH_TOKEN. Never an API key: the environment the
CLI gets has ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN blanked (the CLI reads an empty value as
unset), so a key left in worker/.env or the shell can never switch the worker to API billing. The
same goes for the Bedrock, Vertex and Foundry switches. Costs the CLI reports are API-equivalent
figures (its tokens at API list prices): the worker keeps them as a usage measure and ceiling."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import time
from collections.abc import AsyncIterator, Callable
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
    """`cost_usd` is the failed call's API-equivalent cost when the CLI reported it (a call stopped at
    its max budget, or one whose output failed validation, used its tokens all the same)."""

    def __init__(self, message: str, *, cost_usd: float = 0.0):
        super().__init__(message)
        self.cost_usd = cost_usd


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


@dataclass(frozen=True)
class ImageBlock:
    """An image sent with the user message (base64 in a content block, never a file or a URL)."""

    media_type: str  # image/webp | image/jpeg | image/png | image/gif
    data: bytes


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
        images: list[ImageBlock] | None = None,
        thinking: bool = True,
    ) -> LLMResult[T]: ...


# Variables that would make the CLI bill something other than the signed-in subscription. Each is
# handed to the CLI as "" (unset for it), whatever the worker's own environment holds.
BLANKED_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
)
NOT_SIGNED_IN = (
    "the Claude Code CLI is not signed in: run `claude` once as this user and /login, or put a token from "
    "`claude setup-token` in worker/.env as CLAUDE_CODE_OAUTH_TOKEN"
)
# Signed in to a claude.ai account, the CLI would load that account's claude.ai connectors (mail, docs,
# calendar, trading, ...) into every session, as MCP tools beside prompts built from untrusted articles
# and images. These calls need no tool at all: the connectors are switched off here and every other
# MCP server by --strict-mcp-config (ClaudeLLM.structured), so a session starts with zero tools.
NO_CONNECTORS_ENV = {"ENABLE_CLAUDEAI_MCP_SERVERS": "false"}


def claude_env(oauth_token: str | None = None) -> dict[str, str]:
    """The environment overrides for every CLI the worker starts (queries and `auth status`)."""
    env = dict.fromkeys(BLANKED_ENV, "")
    env.update(NO_CONNECTORS_ENV)
    if oauth_token:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = oauth_token  # never logged
    return env


def cli_path() -> str | None:
    """The CLI the SDK runs: the one bundled with claude-agent-sdk, else `claude` on PATH."""
    try:
        import claude_agent_sdk

        bundled = Path(claude_agent_sdk.__file__).parent / "_bundled" / ("claude.exe" if os.name == "nt" else "claude")
        if bundled.is_file():
            return str(bundled)
    except ImportError:  # pragma: no cover
        pass
    return shutil.which("claude")


def auth_status(oauth_token: str | None = None, *, timeout_s: float = 30.0) -> dict[str, Any]:
    """`claude auth status --json` as the worker's CLI sees it (same binary, same environment). Local
    only: no model call, no tokens. Keys: logged_in, auth_mode (login | oauth_token), auth_method,
    api_provider, subscription, api_key_source (only when the CLI would use a key), error."""
    mode = "oauth_token" if oauth_token or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") else "login"
    out: dict[str, Any] = {"auth_mode": mode, "logged_in": False}
    path = cli_path()
    if not path:
        out["error"] = "no Claude Code CLI found (claude-agent-sdk's bundled CLI or `claude` on PATH)"
        return out
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
    env.update(claude_env(oauth_token))
    try:
        proc = subprocess.run(
            [path, "auth", "status", "--json"], env=env, capture_output=True, text=True, timeout=timeout_s, check=False
        )
        data = json.loads(proc.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        out["error"] = f"`claude auth status` failed: {type(e).__name__}: {str(e)[:200]}"
        return out
    if not isinstance(data, dict):
        out["error"] = "`claude auth status` gave no JSON object"
        return out
    out.update(
        logged_in=bool(data.get("loggedIn")),
        auth_method=data.get("authMethod"),
        api_provider=data.get("apiProvider"),
        subscription=data.get("subscriptionType"),
    )
    if data.get("apiKeySource"):
        out["api_key_source"] = data["apiKeySource"]
    return out


def _user_message(user: str, images: list[ImageBlock]) -> dict[str, Any]:
    """One stream-json user message: the images as base64 content blocks, then the text."""
    content: list[dict[str, Any]] = [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": im.media_type, "data": base64.b64encode(im.data).decode()},
        }
        for im in images
    ]
    content.append({"type": "text", "text": user})
    message = {"role": "user", "content": content}
    return {"type": "user", "session_id": "", "message": message, "parent_tool_use_id": None}


async def _one_message(message: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    yield message


class ClaudeLLM:
    """One `query()` per call: no tools, no MCP servers or claude.ai connectors, no filesystem settings,
    no session persistence.

    The CLI signs in with its own login (or `oauth_token`, a `claude setup-token` token); API-key
    variables are blanked for it (see the module docstring). `auth_problem()` says, without spending
    anything, whether it can run at all."""

    def __init__(
        self,
        *,
        oauth_token: str | None = None,
        cwd: Path | None = None,
        max_turns: int = 3,
        concurrency: int = 3,
        effort: str | None = None,
    ):
        self._oauth_token = oauth_token or None
        self._env = claude_env(self._oauth_token)  # never logged
        self._auth_checked: str | None | bool = False  # False: not asked yet
        self.cwd = cwd
        self.max_turns = max_turns
        self.effort = effort
        self._concurrency = concurrency
        self._sem: asyncio.Semaphore | None = None
        self._sem_loop: asyncio.AbstractEventLoop | None = None

    def _semaphore(self) -> asyncio.Semaphore:
        """One semaphore per event loop: each edition run (catch-up runs included) is its own
        `asyncio.run`, and a semaphore that once waited on an old loop cannot be used on a new one."""
        loop = asyncio.get_running_loop()
        if self._sem is None or self._sem_loop is not loop:
            self._sem, self._sem_loop = asyncio.Semaphore(self._concurrency), loop
        return self._sem

    def auth_status(self) -> dict[str, Any]:
        return auth_status(self._oauth_token)

    def auth_problem(self) -> str | None:
        """Why the CLI cannot make calls (not signed in, not runnable), or None. Asked once per process."""
        if self._auth_checked is False:
            st = self.auth_status()
            problem = st.get("error") or (None if st.get("logged_in") else NOT_SIGNED_IN)
            if not problem:
                logger.info(
                    "Claude Code CLI signed in (%s, %s%s)",
                    st.get("auth_mode"),
                    st.get("auth_method"),
                    f", {st['subscription']} plan" if st.get("subscription") else "",
                )
            self._auth_checked = problem
        return self._auth_checked or None

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
        images: list[ImageBlock] | None = None,
        thinking: bool = True,
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
            # no MCP server of any kind (user, project or claude.ai connector): see NO_CONNECTORS_ENV
            mcp_servers={},
            extra_args={"no-session-persistence": None, "strict-mcp-config": None},
            cwd=str(self.cwd) if self.cwd else None,
            effort=effort or self.effort,  # type: ignore[arg-type]
            # thinking=False for a yes/no judgement (the image check): no reasoning tokens to pay for
            thinking=None if thinking else {"type": "disabled"},
            env=dict(self._env),
        )
        t0 = time.monotonic()
        result: ResultMessage | None = None
        async with self._semaphore():
            try:
                # Images go as content blocks of one streamed user message (the SDK's stream-json input).
                prompt = _one_message(_user_message(user, images)) if images else user
                async for message in query(prompt=prompt, options=options):
                    if isinstance(message, ResultMessage):
                        result = message
            except Exception as e:  # noqa: BLE001 - SDK raises after yielding an error result
                if result is None:
                    raise LLMError(f"{task}: {type(e).__name__}: {str(e)[:300]}") from e
        if result is None:
            raise LLMError(f"{task}: no result message")
        cost = float(result.total_cost_usd or 0.0)
        if result.subtype != "success" or not result.structured_output:
            errs = getattr(result, "errors", None)
            msg = f"{task}: {result.subtype} {errs or ''} {str(result.result or '')[:200]}".strip()
            raise LLMError(msg, cost_usd=cost)
        try:
            output = schema.model_validate(result.structured_output)
        except ValidationError as e:
            raise LLMError(f"{task}: output failed validation: {str(e)[:300]}", cost_usd=cost) from e
        tok = usage_tokens(result.usage, result.model_usage)
        res = LLMResult(
            output=output,
            model=model,
            cost_usd=cost,
            tokens_in=tok["in"],
            tokens_out=tok["out"],
            duration_s=round(time.monotonic() - t0, 1),
            uncached=tok["input"],
            cache_read=tok["cache_read"],
            cache_write=tok["cache_write"],
        )
        logger.info(
            "%s: %s in %.1fs, $%.4f API-equivalent, tokens in=%d (uncached=%d cache_read=%d cache_write=%d) out=%d, "
            "prompt=%d chars",
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

    def auth_problem(self) -> str | None:
        return None

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
        images: list[ImageBlock] | None = None,
        thinking: bool = True,
    ) -> LLMResult[T]:
        self.calls.append(
            {
                "task": task,
                "system": system,
                "user": user,
                "model": model,
                "schema": schema.__name__,
                "images": list(images or []),
            }
        )
        r = self.responses.get(task)
        if r is None:
            # "image:<...>" tasks share one configured answer under "image"
            r = self.responses.get(task.split(":", 1)[0]) if task.startswith("image:") else None
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
