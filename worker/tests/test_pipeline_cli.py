"""CLI exit codes (systemd alerts on any non-zero exit). `config.load` is replaced, so no .env is read."""

import pytest
from pydantic import SecretStr
from typer.testing import CliRunner

from teenpehr import cli, collect_x, pipeline
from teenpehr import config as cfg
from teenpehr.llm import NOT_SIGNED_IN, ClaudeLLM
from teenpehr.pipeline import RunReport

runner = CliRunner()


@pytest.fixture
def s(settings, monkeypatch):
    monkeypatch.setattr(cfg, "load", lambda: settings)
    return settings


def test_date_without_slot_is_refused(s):
    r = runner.invoke(cli.app, ["edition", "--date", "2026-09-22"])
    assert r.exit_code == 2 and "--date needs --slot" in r.output


def test_edition_runs_claude_through_the_claude_code_login(s, monkeypatch):
    """No API key anywhere: the run gets a ClaudeLLM that blanks API-key variables for the CLI and passes
    a `claude setup-token` token through when one is set."""
    seen = {}

    def fake_run_editions(settings, api, llm, fetcher, **kw):
        seen["llm"] = llm
        return [RunReport(run_id="r", status="dry-run")]

    monkeypatch.setattr(pipeline, "run_editions", fake_run_editions)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-stray")
    s.claude_code_oauth_token = SecretStr("oat-123")
    r = runner.invoke(cli.app, ["edition", "--dry-run"])
    assert r.exit_code == 0 and isinstance(seen["llm"], ClaudeLLM)
    env = seen["llm"]._env
    assert env["ANTHROPIC_API_KEY"] == "" and env["ANTHROPIC_AUTH_TOKEN"] == ""
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "oat-123"


def test_edition_exits_2_when_the_claude_code_cli_is_signed_out(s, monkeypatch):
    monkeypatch.setattr(ClaudeLLM, "auth_status", lambda self: {"auth_mode": "login", "logged_in": False})
    monkeypatch.setattr(pipeline.EditionRun, "run", lambda self: pytest.fail("must not run signed out"))
    r = runner.invoke(cli.app, ["edition", "--dry-run"])
    assert r.exit_code == 2 and "not signed in" in r.output


@pytest.mark.parametrize(
    ("statuses", "code"),
    [(["ok"], 0), (["skipped"], 0), (["dry-run"], 0), (["budget"], 1), (["empty"], 1), (["ok", "empty"], 1)],
)
def test_edition_exit_codes(s, monkeypatch, statuses, code):
    seen = {}

    def fake_run_editions(settings, api, llm, fetcher, **kw):
        seen.update(kw)
        return [RunReport(run_id=f"r{i}", status=st) for i, st in enumerate(statuses)]

    monkeypatch.setattr(pipeline, "run_editions", fake_run_editions)
    r = runner.invoke(cli.app, ["edition", "--groups", "pakistan, india"])
    assert r.exit_code == code and seen["groups"] == ["pakistan", "india"]


def test_edition_interrupt_exits_130(s, monkeypatch):
    def stop(*a, **kw):
        raise KeyboardInterrupt

    monkeypatch.setattr(pipeline, "run_editions", stop)
    with pytest.raises(SystemExit) as ei:
        monkeypatch.setattr("sys.argv", ["teenpehr", "edition"])
        cli.main()
    assert ei.value.code == 130


@pytest.mark.parametrize(
    ("status", "lists", "code"), [("ok", 2, 0), ("empty", 2, 1), ("empty", 0, 0), ("failed", 1, 1)]
)
def test_collect_x_exit_codes(s, monkeypatch, status, lists, code):
    monkeypatch.setattr(
        collect_x, "run_collect_x", lambda *a, **kw: collect_x.CollectReport(lists=lists, status=status)
    )
    assert runner.invoke(cli.app, ["collect-x"]).exit_code == code


def test_collect_x_crash_exits_1(s, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("list endpoint gone")

    monkeypatch.setattr(collect_x, "run_collect_x", boom)
    r = runner.invoke(cli.app, ["collect-x"])
    assert r.exit_code == 1 and "list endpoint gone" in r.output


@pytest.mark.parametrize("extra", [["--slot", "subh"], ["--groups", "pakistan"], ["--dry-run"]])
def test_scheduled_takes_no_slot_groups_or_dry_run(s, extra):
    r = runner.invoke(cli.app, ["edition", "--scheduled", *extra])
    assert r.exit_code == 2 and "--scheduled" in r.output


def test_scheduled_passes_through_and_nothing_due_exits_0(s, monkeypatch):
    seen = {}

    def fake_run_editions(settings, api, llm, fetcher, **kw):
        seen.update(kw)
        return []

    monkeypatch.setattr(pipeline, "run_editions", fake_run_editions)
    r = runner.invoke(cli.app, ["edition", "--scheduled"])
    assert r.exit_code == 0 and seen["scheduled"] is True


def test_scheduled_with_a_slot_due_and_the_cli_signed_out_exits_2(s, monkeypatch):
    def fake_run_editions(settings, api, llm, fetcher, **kw):
        raise pipeline.ConfigError(f"2026-09-23-dopahar is due, but {NOT_SIGNED_IN}")

    monkeypatch.setattr(pipeline, "run_editions", fake_run_editions)
    r = runner.invoke(cli.app, ["edition", "--scheduled"])
    assert r.exit_code == 2 and "not signed in" in r.output


# ---- health: the web API and the Claude Code sign-in, without spending tokens -----------------------
def test_health_reports_the_claude_sign_in_and_exits_1_when_signed_out(s, monkeypatch):
    import json

    from teenpehr import llm
    from teenpehr.api import WorkerApi

    monkeypatch.setattr(WorkerApi, "health", lambda self: {"ok": True})
    status = {"auth_mode": "login", "logged_in": True, "auth_method": "claude.ai", "subscription": "max"}
    monkeypatch.setattr(llm, "auth_status", lambda token=None: dict(status))
    r = runner.invoke(cli.app, ["health"])
    assert r.exit_code == 0
    out = json.loads(r.output)
    assert out["web"] == {"ok": True} and out["claude"]["logged_in"] and out["claude"]["api_key_ignored"] is False
    status["logged_in"] = False
    assert runner.invoke(cli.app, ["health"]).exit_code == 1
