"""Command line entry point (`teenpehr ...`)."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import typer

from . import config as cfg
from . import log
from .api import ApiError, WorkerApi

app = typer.Typer(help="Tabayyun news worker", no_args_is_help=True, add_completion=False)


def _api(s: cfg.Settings) -> WorkerApi:
    if not s.worker_token:
        typer.echo("WORKER_TOKEN is not set (see .env)", err=True)
        raise typer.Exit(2)
    return WorkerApi(s.site_url, s.worker_token)


def _oauth_token(s: cfg.Settings) -> str | None:
    return s.claude_code_oauth_token.get_secret_value() if s.claude_code_oauth_token else None


def _warn_stray_key(s: cfg.Settings) -> None:
    if s.has_stray_api_key:
        log.get("cli").warning(
            "ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set (worker/.env or the environment) and ignored: "
            "the worker runs Claude through the Claude Code login, never an API key; remove it"
        )


@app.callback()
def _root(log_level: str = typer.Option("INFO", "--log-level", help="DEBUG, INFO, WARNING")):
    log.setup(log_level.upper())


# Exit codes: 0 = an edition was delivered, or there was nothing to do (already published or held,
# dry run, a timer firing with no slot due); 1 = the slot has no edition (failed, empty, daily
# budget reached, web app down when a slot fell due); 2 = bad arguments or configuration;
# 130 = interrupted. systemd's OnFailure alert fires on anything but 0.
_EDITION_OK = ("ok", "dry-run", "skipped")


@app.command()
def edition(
    slot: str | None = typer.Option(None, help="subh | dopahar | shaam (default: the latest slot that has passed)"),
    date: str | None = typer.Option(None, help="YYYY-MM-DD (needs --slot)"),
    dry_run: bool = typer.Option(False, "--dry-run", help="No writes; write out/<run_id>.json instead"),
    groups: str | None = typer.Option(None, help="Comma-separated group slugs to run (replaces only those groups)"),
    scheduled: bool = typer.Option(
        False, "--scheduled", help="For the timer: run the slot that is due by the admin's edition times, once"
    ),
):
    """Run one edition: collect, curate, write Urdu, check, publish. An automatic run then also runs
    a slot that came due while it worked. Claude runs through the Claude Code CLI signed in on this
    machine (or CLAUDE_CODE_OAUTH_TOKEN); a run that finds it signed out exits 2."""
    from .fetch.http import Fetcher
    from .llm import ClaudeLLM
    from .pipeline import ConfigError, run_editions

    s = cfg.load()
    if slot and slot not in ("subh", "dopahar", "shaam"):
        typer.echo("slot must be subh, dopahar or shaam", err=True)
        raise typer.Exit(2)
    if date and not slot:
        typer.echo(f"--date needs --slot (which edition of {date}?)", err=True)
        raise typer.Exit(2)
    if scheduled and (slot or date or groups or dry_run):
        typer.echo("--scheduled picks the slot itself; it takes no --slot, --date, --groups or --dry-run", err=True)
        raise typer.Exit(2)
    _warn_stray_key(s)
    api = _api(s)
    try:
        # The CLI's sign-in is checked once a slot is due (a timer firing with nothing due never starts
        # it); signed out, a due slot fails once, then waits quietly until the CLI is signed in again.
        reports = run_editions(
            s,
            api,
            ClaudeLLM(oauth_token=_oauth_token(s), cwd=s.out_dir),
            Fetcher(s),
            slot=slot,
            date=date,
            groups=[g.strip() for g in groups.split(",") if g.strip()] if groups else None,
            dry_run=dry_run or None,
            scheduled=scheduled,
        )
    except ConfigError as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(2) from None
    except ApiError as e:
        typer.echo(f"API error {e.status}: {e.message} {json.dumps(e.issues) if e.issues else ''}", err=True)
        raise typer.Exit(1) from None
    except Exception as e:  # noqa: BLE001 - already logged with traceback
        typer.echo(f"run failed: {type(e).__name__}: {e}", err=True)
        raise typer.Exit(1) from None
    finally:
        api.close()
    for report in reports:
        typer.echo(json.dumps(report.__dict__, ensure_ascii=False, indent=2))
    if any(r.status not in _EDITION_OK for r in reports):
        raise typer.Exit(1)


@app.command("collect-x")
def collect_x(dry_run: bool = typer.Option(False, "--dry-run")):
    """Read every group's public X Lists and watched Bluesky accounts, and store the posts."""
    from .collect_x import run_collect_x
    from .fetch.http import Fetcher
    from .social.bluesky import fetch_json
    from .social.x_list import XListClient, fetch_html

    s = cfg.load()
    api = _api(s)
    fetcher = Fetcher(s)
    # fetch_html raises XRateLimited on a 429 (or a host still cooling down), so the run stops early
    # and says so instead of reporting every list as broken.
    client = XListClient(fetch_html(fetcher), spacing_s=s.x_list_spacing_s)
    try:
        report = run_collect_x(s, api, client, dry_run=dry_run or None, bluesky_get=fetch_json(fetcher))
    except ApiError as e:
        typer.echo(f"API error {e.status}: {e.message} {json.dumps(e.issues) if e.issues else ''}", err=True)
        raise typer.Exit(1) from None
    except Exception as e:  # noqa: BLE001 - already logged with traceback
        typer.echo(f"collect-x failed: {type(e).__name__}: {e}", err=True)
        raise typer.Exit(1) from None
    finally:
        api.close()
    typer.echo(json.dumps(report.__dict__, ensure_ascii=False, indent=2))
    # No posts from any configured List means the endpoint died or every List broke: exit non-zero so
    # the unit's failure alert fires. With no Lists configured there is simply nothing to do.
    if report.status == "failed" or (report.status == "empty" and report.lists > 0):
        raise typer.Exit(1)


@app.command("check-sources")
def check_sources(
    group: str | None = typer.Option(None, help="Only this group slug"),
    url: list[str] = typer.Option(None, "--url", help="Check ad-hoc feed URLs instead of the configured sources"),  # noqa: B008
    route: str = typer.Option("direct", help="Route for --url checks: direct | germany"),
):
    """Fetch every active source once and print what came back (no writes)."""
    from .fetch import rss, youtube
    from .fetch.http import Fetcher
    from .models import Source

    s = cfg.load()
    fetcher = Fetcher(s, state_file=s.state_dir / "check-sources.json")
    if url:
        sources = [Source(id=i, group_id=0, name=u[:40], kind="rss", url=u, route=route) for i, u in enumerate(url, 1)]  # type: ignore[arg-type]
    else:
        api = _api(s)
        try:
            config = api.config()
        finally:
            api.close()
        gid = {g.slug: g.id for g in config.groups}.get(group) if group else None
        sources = [x for x in config.sources if gid is None or x.group_id == gid]
    now = datetime.now(UTC)
    rows, ok = [], 0
    for src in sources:
        r = fetcher.get(src.url, route=src.route)
        n, newest, err = 0, "-", r.error or ""
        if r.ok:
            try:
                entries = (
                    youtube.parse_channel_feed(r.content)
                    if src.kind == "youtube"
                    else rss.parse_feed(r.content, feed_url=r.url)
                )
                n = len(entries)
                dated = [e.published for e in entries if e.published]
                if dated:
                    age_h = (now - max(dated)).total_seconds() / 3600
                    newest = f"{age_h:.1f}h"
                ok += 1
            except Exception as e:  # noqa: BLE001
                err = f"parse: {e}"
        route_used = r.route_used + ("*" if r.fell_back else "")
        rows.append((src.name[:28], src.kind, route_used, r.status, n, r.ms, newest, err[:50]))
    typer.echo(f"{'source':28} {'kind':7} {'route':9} {'http':5} {'items':5} {'ms':6} {'newest':7} error")
    for row in rows:
        typer.echo(f"{row[0]:28} {row[1]:7} {row[2]:9} {row[3]:<5} {row[4]:<5} {row[5]:<6} {row[6]:7} {row[7]}")
    typer.echo(f"\n{ok}/{len(rows)} sources returned a parseable feed  (* = fell back to Germany)")


@app.command("check-x")
def check_x(list_id: str = typer.Argument(..., help="Public X List id")):
    """Fetch one X List through the syndication endpoint and summarise it (no writes)."""
    from .fetch.http import Fetcher
    from .social.x_list import XListClient, fetch_html, health

    s = cfg.load()
    client = XListClient(fetch_html(Fetcher(s)), spacing_s=0)
    posts = client.list_posts(list_id)
    authors = sorted({p.author_handle for p in posts})
    newest = max((p.posted_at for p in posts), default=None)
    typer.echo(f"list {list_id}: {len(posts)} posts, {len(authors)} authors, newest {newest}")
    typer.echo(f"health: {health(posts) or 'ok'}")
    for p in posts[:5]:
        typer.echo(f"  @{p.author_handle} {p.posted_at:%H:%M}: {p.text[:90]!r}")


@app.command()
def resubmit(
    file: Path = typer.Argument(..., help="out/failed-<run_id>.json written by a run whose delivery failed"),  # noqa: B008
    publish: bool = typer.Option(True, "--publish/--no-publish", help="Publish after the PUT (default yes)"),
):
    """PUT (and publish) a saved edition without calling Claude again."""
    from .pipeline import resubmit as _resubmit

    s = cfg.load()
    api = _api(s)
    try:
        result = _resubmit(api, file, publish=publish)
    except ApiError as e:
        typer.echo(f"API error {e.status}: {e.message} {json.dumps(e.issues) if e.issues else ''}", err=True)
        raise typer.Exit(1) from None
    except (ValueError, OSError) as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(2) from None
    finally:
        api.close()
    typer.echo(json.dumps(result, ensure_ascii=False, indent=2))


@app.command()
def health():
    """Check the web API is reachable with this token, and that the Claude Code CLI is signed in
    (`claude auth status`: local, no model call, no tokens). Exits 1 if either is not."""
    from .llm import auth_status

    s = cfg.load()
    _warn_stray_key(s)
    api = _api(s)
    ok = True
    report: dict = {}
    try:
        report["web"] = api.health()
    except ApiError as e:
        report["web"] = {"ok": False, "error": f"API error {e.status}: {e.message}"}
        ok = False
    except Exception as e:  # noqa: BLE001 - unreachable app: still report Claude's side
        report["web"] = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}
        ok = False
    finally:
        api.close()
    claude = auth_status(_oauth_token(s))
    claude["api_key_ignored"] = s.has_stray_api_key
    report["claude"] = claude
    if not claude.get("logged_in") or claude.get("error"):
        ok = False
    typer.echo(json.dumps(report, indent=2))
    if not ok:
        raise typer.Exit(1)


_JOB_KINDS = ("translate_article", "fill_language", "story_image")


@app.command()
def jobs(
    once: bool = typer.Option(False, "--once", help="Claim and do at most one job, then exit"),
    kinds: str | None = typer.Option(
        None, help="Comma-separated job kinds: translate_article, fill_language, story_image (default: all)"
    ),
    concurrency: int | None = typer.Option(None, help="Jobs at a time (default JOBS_CONCURRENCY, 1; at most 4)"),
    max_jobs: int | None = typer.Option(None, "--max-jobs", help="Stop after this many jobs"),
):
    """Do the jobs the site queues between editions (docs/API.md § Jobs): full-article Urdu translations
    readers ask for, and a manual story's missing language and image. Runs until SIGINT/SIGTERM (the first
    lets the current job finish; a second stops it now and it is queued again). Exit codes: 0, or with
    --once 1 when the job failed or the web app did not answer; 2 for bad arguments or configuration."""
    import asyncio

    from .fetch.http import Fetcher
    from .jobs import JobRunner
    from .llm import ClaudeLLM

    picked = [k.strip() for k in kinds.split(",") if k.strip()] if kinds else list(_JOB_KINDS)
    unknown = [k for k in picked if k not in _JOB_KINDS]
    if unknown or not picked:
        given = ", ".join(unknown) or "(none given)"
        typer.echo(f"unknown job kind(s): {given}; use {', '.join(_JOB_KINDS)}", err=True)
        raise typer.Exit(2)
    if concurrency is not None and not 1 <= concurrency <= 4:
        typer.echo("--concurrency must be 1 to 4", err=True)
        raise typer.Exit(2)
    s = cfg.load()
    _warn_stray_key(s)
    api = _api(s)
    runner = JobRunner(
        s,
        api,
        ClaudeLLM(oauth_token=_oauth_token(s), cwd=s.out_dir),
        Fetcher(s),
        kinds=picked,  # type: ignore[arg-type]
        concurrency=concurrency,
    )
    try:
        report = asyncio.run(runner.run(once=once, max_jobs=max_jobs, install_signals=True))
    finally:
        api.close()
    if once or max_jobs:
        typer.echo(json.dumps(report.as_dict(), ensure_ascii=False, indent=2, default=str))
    if once and (report.status == "api_error" or any(j.status in ("failed", "lost") for j in report.jobs)):
        raise typer.Exit(1)


@app.command("translate-url")
def translate_url(
    url: str = typer.Argument(..., help="An article's http(s) address"),
    route: str = typer.Option("direct", help="direct | germany (the route its source uses)"),
    title: str = typer.Option("", help="The headline to translate (default: the page's own)"),
    fetch_only: bool = typer.Option(False, "--fetch-only", help="Only fetch and extract the text: no Claude call"),
    out: Path | None = typer.Option(None, help="Where to write the JSON (default: out/translate-<hash>.json)"),  # noqa: B008
):
    """Fetch and translate one article into Urdu exactly as a translate_article job would, but locally:
    nothing is sent to the web app and the result is written to a JSON file. The fetch keeps every rule
    (robots.txt, 429 cooldowns, paywalls never bypassed); the Claude calls count toward the daily ceiling.
    The locked glossary is read from the web app when WORKER_TOKEN is set."""
    import asyncio

    from .fetch.http import Fetcher
    from .jobs import budget
    from .jobs.base import BudgetReached, Usage
    from .jobs.fulltext import FullTextFetcher, TryLater, Unavailable
    from .jobs.translate_article import LANG_NAMES
    from .llm import ClaudeLLM, LLMError
    from .translate import ArticleTranslator, TranslationFailed

    if route not in ("direct", "germany"):
        typer.echo("--route must be direct or germany", err=True)
        raise typer.Exit(2)
    s = cfg.load()
    fetcher = Fetcher(s)
    try:
        full = FullTextFetcher(fetcher, s).fetch(url, route=route, last_attempt=True, title_hint=title)
    except Unavailable as e:
        typer.echo(json.dumps({"url": url, "blocked": {"reason": e.reason, "note": e.note}}, ensure_ascii=False))
        return
    except TryLater as e:  # never raised with last_attempt, kept for safety
        typer.echo(json.dumps({"url": url, "try_later": e.note}, ensure_ascii=False))
        raise typer.Exit(1) from None
    finally:
        fetcher.save_state()
    record: dict = {
        "url": url,
        "final_url": full.final_url,
        "route": full.route,
        "lang": full.lang,
        "words": full.words,
        "source_text_hash": full.text_hash,
        "source_title": full.title,
        "source_paragraphs": full.paragraphs,
    }
    path = out or s.out_dir / f"translate-{full.text_hash[:12]}.json"
    if not fetch_only:
        glossary = []
        if s.worker_token:
            api = WorkerApi(s.site_url, s.worker_token)
            try:
                glossary = api.config().glossary
            except Exception as e:  # noqa: BLE001 - the glossary is a nicety here
                typer.echo(f"(no glossary: {type(e).__name__}: {str(e)[:120]})", err=True)
            finally:
                api.close()
        _warn_stray_key(s)
        llm = ClaudeLLM(oauth_token=_oauth_token(s), cwd=s.out_dir)
        problem = llm.auth_problem()
        if problem:
            typer.echo(problem, err=True)
            raise typer.Exit(2)
        usage = Usage()
        translator = ArticleTranslator(
            s,
            llm,
            account=usage.add,
            account_failure=usage.add_failure,
            budget_ok=lambda: budget.spent_today(s) + usage.cost_usd < s.daily_budget_usd,
            over_budget=lambda: BudgetReached("the daily usage ceiling was reached"),
            spent=lambda: usage.cost_usd,
        )
        lang = full.lang or "en"
        try:
            tr = asyncio.run(
                translator.translate(
                    key="url",
                    title=full.title,
                    paragraphs=full.paragraphs,
                    outlet=full.site_name or "",
                    source_lang=LANG_NAMES.get(lang, lang),
                    glossary=glossary,
                )
            )
        except (LLMError, TranslationFailed, BudgetReached) as e:
            typer.echo(f"translation failed: {e}", err=True)
            raise typer.Exit(1) from None
        finally:
            budget.add_spend(s, usage.cost_usd)
        record.update(
            title=tr.title,
            body=tr.body,
            check_ok=tr.check_ok,
            check_note=tr.check_note,
            repaired=tr.repaired,
            **usage.fields(tr.model),
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {k: v for k, v in record.items() if k not in ("source_paragraphs", "body")}
    summary["file"] = str(path)
    typer.echo(json.dumps(summary, ensure_ascii=False, indent=2))


def main() -> None:
    try:
        app()
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
