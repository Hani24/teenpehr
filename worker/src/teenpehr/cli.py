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

app = typer.Typer(help="Teen Pehr news worker", no_args_is_help=True, add_completion=False)


def _api(s: cfg.Settings) -> WorkerApi:
    if not s.worker_token:
        typer.echo("WORKER_TOKEN is not set (see .env)", err=True)
        raise typer.Exit(2)
    return WorkerApi(s.site_url, s.worker_token)


def _fetch_html(fetcher):
    def go(url: str, headers: dict[str, str]) -> str:
        r = fetcher.get(url, headers=headers, allow_fallback=False)
        if not r.ok:
            raise RuntimeError(r.error or f"http {r.status}")
        return r.content.decode("utf-8", "replace")

    return go


@app.callback()
def _root(log_level: str = typer.Option("INFO", "--log-level", help="DEBUG, INFO, WARNING")):
    log.setup(log_level.upper())


@app.command()
def edition(
    slot: str | None = typer.Option(None, help="subh | dopahar | shaam (default: the latest slot that has passed)"),
    date: str | None = typer.Option(None, help="YYYY-MM-DD (with --slot)"),
    dry_run: bool = typer.Option(False, "--dry-run", help="No writes; write out/<run_id>.json instead"),
    groups: str | None = typer.Option(None, help="Comma-separated group slugs to run"),
):
    """Run one edition: collect, curate, write Urdu, check, publish."""
    from .fetch.http import Fetcher
    from .llm import ClaudeLLM
    from .pipeline import EditionRun

    s = cfg.load()
    if slot and slot not in ("subh", "dopahar", "shaam"):
        typer.echo("slot must be subh, dopahar or shaam", err=True)
        raise typer.Exit(2)
    api = _api(s)
    run = EditionRun(
        s,
        api,
        ClaudeLLM(cwd=s.out_dir),
        Fetcher(s),
        slot=slot,
        date=date,
        groups=groups.split(",") if groups else None,
        dry_run=dry_run or None,
    )
    try:
        report = run.run()
    except ApiError as e:
        typer.echo(f"API error {e.status}: {e.message} {json.dumps(e.issues) if e.issues else ''}", err=True)
        raise typer.Exit(1) from None
    except Exception as e:  # noqa: BLE001 - already logged with traceback
        typer.echo(f"run failed: {type(e).__name__}: {e}", err=True)
        raise typer.Exit(1) from None
    finally:
        api.close()
    typer.echo(json.dumps(report.__dict__, ensure_ascii=False, indent=2))
    if report.status in ("failed",):
        raise typer.Exit(1)


@app.command("collect-x")
def collect_x(dry_run: bool = typer.Option(False, "--dry-run")):
    """Read every group's public X Lists and store the posts."""
    from .collect_x import run_collect_x
    from .fetch.http import Fetcher
    from .social.x_list import XListClient

    s = cfg.load()
    api = _api(s)
    client = XListClient(_fetch_html(Fetcher(s)), spacing_s=s.x_list_spacing_s)
    try:
        report = run_collect_x(s, api, client, dry_run=dry_run or None)
    finally:
        api.close()
    typer.echo(json.dumps(report.__dict__, ensure_ascii=False, indent=2))
    if report.status == "failed":
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
    from .social.x_list import XListClient, health

    s = cfg.load()
    client = XListClient(_fetch_html(Fetcher(s)), spacing_s=0)
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
    """Check the web API is reachable with this token."""
    s = cfg.load()
    api = _api(s)
    try:
        typer.echo(json.dumps(api.health()))
    except ApiError as e:
        typer.echo(f"API error {e.status}: {e.message}", err=True)
        raise typer.Exit(1) from None
    finally:
        api.close()


def main() -> None:
    try:
        app()
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
