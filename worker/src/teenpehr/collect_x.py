"""The X collector (every 30 minutes): read each group's public Lists through the syndication
endpoint, store the posts, record when each watched handle last posted, and fall back to a paid
API for handles that have gone quiet when a key is configured."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

from . import log
from .api import WorkerApi
from .config import Settings
from .models import PostIn, RunFinish
from .social import twitterapi_io
from .social.x_list import XListClient, XListError, health

logger = log.get("collect_x")


@dataclass
class CollectReport:
    lists: int = 0
    posts: int = 0
    new_posts: int = 0
    warnings: list[str] = field(default_factory=list)
    fallback_handles: list[str] = field(default_factory=list)
    status: str = "ok"


def run_collect_x(
    settings: Settings, api: WorkerApi, client: XListClient, *, dry_run: bool | None = None
) -> CollectReport:
    dry = settings.dry_run if dry_run is None else dry_run
    report = CollectReport()
    config = api.config()
    run_id = None if dry else api.start_run("x_collect")
    lines: list[str] = []
    try:
        posts_by_id: dict[str, PostIn] = {}
        for g in sorted(config.groups, key=lambda g: g.order):
            for list_id in g.x_list_ids:
                report.lists += 1
                try:
                    posts = client.list_posts(list_id)
                except XListError as e:
                    msg = f"list {list_id} ({g.slug}): {e}"
                    report.warnings.append(msg)
                    logger.warning(msg)
                    continue
                except Exception as e:  # noqa: BLE001
                    msg = f"list {list_id} ({g.slug}): {type(e).__name__}: {str(e)[:160]}"
                    report.warnings.append(msg)
                    logger.warning(msg)
                    continue
                problem = health(posts, stale_hours=6.0)
                if problem:
                    msg = f"list {list_id} ({g.slug}) looks unhealthy: {problem}"
                    report.warnings.append(msg)
                    logger.warning(msg)
                for p in posts:
                    posts_by_id.setdefault(p.platform_id, p)
                lines.append(f"list {list_id} ({g.slug}): {len(posts)} posts")
                logger.info(lines[-1])
        all_posts = list(posts_by_id.values())
        report.posts = len(all_posts)

        watched = {h.handle.lower(): h for h in config.handles if h.platform == "x"}
        seen_handles: set[str] = set()
        if all_posts and not dry:
            outs = api.post_posts(run_id, all_posts)
            report.new_posts = sum(1 for o in outs if o.is_new)
            latest: dict[int, datetime] = {}
            by_pid = {p.platform_id: p for p in all_posts}
            for o in outs:
                p = by_pid.get(o.platform_id)
                if o.handle_id and p:
                    latest[o.handle_id] = max(latest.get(o.handle_id, p.posted_at), p.posted_at)
                    seen_handles.add(p.author_handle.lower())
            for hid, when in latest.items():
                try:
                    api.handle_seen(hid, when)
                except Exception as e:  # noqa: BLE001
                    logger.warning("handle_seen %s failed: %s", hid, e)
        elif all_posts:
            report.new_posts = len(all_posts)
            seen_handles = {p.author_handle.lower() for p in all_posts}

        # paid fallback for handles that have gone quiet (only when configured and known-stale)
        if settings.twitterapi_io_key and not dry:
            now = datetime.now(UTC)
            for key, h in watched.items():
                if key in seen_handles or not h.last_post_at:
                    continue
                if (now - h.last_post_at).total_seconds() < settings.x_stale_hours * 3600:
                    continue
                try:
                    fb = twitterapi_io.last_tweets(settings.twitterapi_io_key, h.handle)
                except Exception as e:  # noqa: BLE001
                    logger.warning("fallback for @%s failed: %s", h.handle, e)
                    continue
                if fb:
                    outs = api.post_posts(run_id, fb)
                    report.new_posts += sum(1 for o in outs if o.is_new)
                    api.handle_seen(h.id, max(p.posted_at for p in fb), fallback_used=True)
                report.fallback_handles.append(h.handle)

        status = "ok" if all_posts else "empty"
        if not dry and run_id is not None:
            api.finish_run(run_id, RunFinish(status=status, log="\n".join(lines + report.warnings)))  # type: ignore[arg-type]
        report.status = status
        return report
    except Exception as e:
        logger.exception("collect-x failed")
        if not dry and run_id is not None:
            api.finish_run(run_id, RunFinish(status="failed", error=f"{type(e).__name__}: {str(e)[:300]}"))
        report.status = "failed"
        raise
