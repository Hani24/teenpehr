"""The edition run: collect → dedupe → curate (Claude) → Urdu (Claude) → QA (Claude) → publish.

Code does the fetching and bookkeeping; Claude only judges. A run is keyed by date+slot and is
idempotent on the server (the edition PUT upserts a draft until it is published). DRY_RUN makes
no write at all: no run row, no items, no edition; it writes out/<run_id>.json instead."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from . import log
from .api import ApiError, WorkerApi
from .config import Settings
from .fetch import article, gnews, rss, youtube
from .fetch.http import Fetcher
from .llm import LLM, LLMError, load_prompt
from .models import (
    AngleIn,
    Config,
    CurateOut,
    EditionGroupIn,
    EditionIn,
    Group,
    ItemIn,
    QaOut,
    RunFinish,
    RunSourceResult,
    Source,
    SourceRef,
    StoryIn,
    UrduOut,
)
from .normalize import canonical_url, content_hash, normalize_urdu, slugify, title_key
from .notify import ntfy
from .render import (
    NumberedItem,
    render_glossary,
    render_items,
    render_stories_for_qa,
    render_stories_for_urdu,
    render_threads,
)

logger = log.get("pipeline")

SLOT_ORDER = ["subh", "dopahar", "shaam"]
MAX_ARTICLES_PER_GROUP = 120
MAX_POSTS_PER_GROUP = 40
SHORT_TEXT = 200  # feed blurbs shorter than this get an article fetch


# ---- slot arithmetic ---------------------------------------------------------------------------
@dataclass
class SlotInfo:
    date: str
    slot: str
    slot_at: datetime
    prev_slot_at: datetime
    backfill: bool
    lookback_hours: float

    @property
    def run_id(self) -> str:
        return f"{self.date}-{self.slot}"

    @property
    def since(self) -> datetime:
        return self.slot_at - timedelta(hours=self.lookback_hours)


def _parse_hhmm(value: str) -> tuple[int, int]:
    h, m = value.split(":")
    return int(h), int(m)


def resolve_slot(
    now: datetime,
    edition_times: dict[str, str],
    *,
    slot: str | None = None,
    date: str | None = None,
    overlap_hours: float = 2.0,
    backfill_after_hours: float = 2.0,
    lookback_override: float | None = None,
) -> SlotInfo:
    """Pick the edition this run belongs to and the window it should cover.

    Without overrides: the latest slot whose time is at or before `now` (yesterday's last slot
    before the first slot of the day). The window starts at the previous slot minus the overlap."""
    tz = now.tzinfo
    ordered = sorted(((s, _parse_hhmm(edition_times[s])) for s in SLOT_ORDER if s in edition_times), key=lambda x: x[1])
    if not ordered:
        raise ValueError("no edition_times configured")

    def at(day: datetime, hm: tuple[int, int]) -> datetime:
        return day.replace(hour=hm[0], minute=hm[1], second=0, microsecond=0, tzinfo=tz)

    if slot:
        day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=tz) if date else now
        hm = dict(ordered)[slot]
        slot_at = at(day, hm)
    else:
        day = now
        candidates = [(s, at(day, hm)) for s, hm in ordered if at(day, hm) <= now]
        if candidates:
            slot, slot_at = candidates[-1]
        else:
            s, hm = ordered[-1]
            slot, slot_at = s, at(day - timedelta(days=1), hm)
    idx = [s for s, _ in ordered].index(slot)
    prev_at = at(slot_at, ordered[idx - 1][1]) if idx > 0 else at(slot_at - timedelta(days=1), ordered[-1][1])
    gap_h = (slot_at - prev_at).total_seconds() / 3600
    lookback = lookback_override if lookback_override else gap_h + overlap_hours
    backfill = (now - slot_at).total_seconds() / 3600 > backfill_after_hours
    return SlotInfo(slot_at.strftime("%Y-%m-%d"), slot, slot_at, prev_at, backfill, lookback)


# ---- log capture for the run row ----------------------------------------------------------------
class _TailHandler(logging.Handler):
    def __init__(self, n: int = 300):
        super().__init__()
        self.lines: deque[str] = deque(maxlen=n)

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self.format(record))


# ---- collection ---------------------------------------------------------------------------------
@dataclass
class SourceBatch:
    source: Source
    items: list[ItemIn]
    result: RunSourceResult
    timed_out: bool = False


class Collector:
    def __init__(self, settings: Settings, fetcher: Fetcher, *, now: datetime):
        self.s = settings
        self.fetcher = fetcher
        self.now = now
        self._seen: set[str] = set()
        self._seen_lock = threading.Lock()
        self._article_budget = settings.article_fetch_limit
        self._budget_lock = threading.Lock()

    def _claim(self, keys: list[str]) -> bool:
        with self._seen_lock:
            if any(k in self._seen for k in keys):
                return False
            self._seen.update(keys)
            return True

    def _take_article_budget(self) -> bool:
        with self._budget_lock:
            if self._article_budget <= 0:
                return False
            self._article_budget -= 1
            return True

    def _follow(self, url: str) -> str | None:
        r = self.fetcher.get(url, allow_fallback=False)
        return r.final_url or None

    def fetch_source(self, source: Source, since: datetime) -> SourceBatch:
        t0 = time.monotonic()
        result = RunSourceResult(source_id=source.id, ok=False, tier=1, route=source.route)
        try:
            res = self.fetcher.get(source.url, route=source.route, conditional=True)
        except Exception as e:  # noqa: BLE001
            result.error = f"{type(e).__name__}: {str(e)[:200]}"
            result.ms = int((time.monotonic() - t0) * 1000)
            return SourceBatch(source, [], result)
        result.route = "germany" if res.route_used == "germany" else "direct"
        result.ms = res.ms
        if res.not_modified:
            result.ok = True
            return SourceBatch(source, [], result)
        if not res.ok:
            result.error = res.error or f"http {res.status}"
            batch = SourceBatch(source, [], result)
            batch.timed_out = res.timed_out
            return batch
        try:
            if source.kind == "youtube":
                entries = youtube.parse_channel_feed(res.content)
            else:
                entries = rss.parse_feed(res.content, feed_url=res.url)
        except Exception as e:  # noqa: BLE001
            result.error = f"parse: {type(e).__name__}: {str(e)[:200]}"
            return SourceBatch(source, [], result)

        items: list[ItemIn] = []
        for en in entries:
            if len(items) >= source.max_items:
                break
            if not en.link:
                continue
            if en.published and en.published < since:
                continue  # undated entries are kept; the API's is_new=false stops repeats across runs
            title, link, text = en.title, en.link, en.summary
            if source.kind == "gnews":
                title = gnews.clean_title(title)
                text = ""
                link = gnews.decode_link(link, follow=self._follow)
            canon = canonical_url(link)
            tkey = title_key(title)
            if not tkey or not self._claim([f"u:{canon}", f"t:{tkey}"]):
                continue
            items.append(
                ItemIn(
                    source_id=source.id,
                    url=link,
                    url_canonical=canon,
                    title=title,
                    text=text[:20_000],
                    published_at=en.published,
                    lang=source.lang,
                    content_hash=content_hash(canon, title),
                )
            )
        # short blurbs → fetch the article body (bounded per run)
        for it in items:
            if len(it.text) >= SHORT_TEXT or source.kind == "youtube":
                continue
            if not self._take_article_budget():
                break
            try:
                page = self.fetcher.get(it.url, route=result.route, allow_fallback=False)
                if page.ok:
                    body = article.extract_text(page.content, it.url)
                    if len(body) > len(it.text):
                        it.text = body
            except Exception as e:  # noqa: BLE001
                logger.debug("article fetch failed for %s: %s", it.url, e)
        result.ok = True
        result.items = len(items)
        result.ms = int((time.monotonic() - t0) * 1000)
        return SourceBatch(source, items, result)

    def collect(self, sources: list[Source], since: datetime) -> list[SourceBatch]:
        fetchable = [s for s in sources if s.kind in ("rss", "gnews", "youtube")]
        skipped = [s for s in sources if s not in fetchable]
        for s in skipped:
            logger.info("skipping %s: kind %s not fetchable by this worker yet", s.name, s.kind)
        with ThreadPoolExecutor(max_workers=self.s.fetch_workers) as ex:
            batches = list(ex.map(lambda s: self.fetch_source(s, since), fetchable))
        # A feed that timed out while eight others were in flight usually answers in seconds alone;
        # retry those once, sequentially, before calling them failed.
        for i, b in enumerate(batches):
            if b.timed_out:
                logger.info("%s: timed out, retrying once", b.source.name)
                retry = self.fetch_source(b.source, since)
                if retry.result.ok:
                    batches[i] = retry
        for b in batches:
            if b.result.ok:
                logger.info("%s: %d items in %d ms via %s", b.source.name, b.result.items, b.result.ms, b.result.route)
            else:
                logger.warning("%s: FAILED %s", b.source.name, b.result.error)
        self.fetcher.save_state()
        return batches


# ---- per-group editorial work -----------------------------------------------------------------
@dataclass
class GroupWork:
    group: Group
    articles: list[NumberedItem]
    posts: list[NumberedItem]
    lead_en: str = ""
    lead_ur: str = ""
    stories: list[StoryIn] = field(default_factory=list)
    fallback: bool = False
    errors: list[str] = field(default_factory=list)
    glossary_additions: list[dict[str, str]] = field(default_factory=list)

    @property
    def numbered(self) -> list[NumberedItem]:
        return self.articles + self.posts

    @property
    def by_idx(self) -> dict[int, NumberedItem]:
        return {i.idx: i for i in self.numbered}

    @property
    def by_db_id(self) -> dict[int, NumberedItem]:
        return {i.db_id: i for i in self.numbered}


def fallback_stories(gw: GroupWork, limit: int) -> list[StoryIn]:
    """Raw headlines, newest first, when the AI curation failed for a group."""
    ranked = sorted(gw.articles, key=lambda i: i.published or datetime.min.replace(tzinfo=UTC), reverse=True)
    return [
        StoryIn(
            order=n,
            title_en=it.title,
            summary_en=(it.text or it.title)[:300],
            tag="skim",
            coverage="single-source",
            sources=[SourceRef(item_id=it.db_id, is_primary=True)],
        )
        for n, it in enumerate(ranked[:limit])
    ]


def curation_to_stories(out: CurateOut, gw: GroupWork, known_threads: set[str], date: str) -> list[StoryIn]:
    """Validate every reference against the input and build API stories. Invalid stories are dropped."""
    article_idx = {a.idx for a in gw.articles}
    post_idx = {p.idx for p in gw.posts}
    by_idx = gw.by_idx
    stories: list[StoryIn] = []
    for st in out.stories:
        refs = list(dict.fromkeys([st.ref, *st.refs]))
        bad = [r for r in refs if r not in article_idx] + [p for p in st.posts if p not in post_idx]
        bad += [a.ref for a in st.angles if a.ref not in article_idx]
        if bad:
            gw.errors.append(f"dropped '{st.title[:60]}': unknown refs {bad[:5]}")
            logger.warning("%s: %s", gw.group.slug, gw.errors[-1])
            continue
        thread, t_en = None, None
        if st.thread and st.thread in known_threads:
            thread = st.thread
        elif st.thread_title:
            thread, t_en = f"{slugify(st.thread_title)}-{date[:7]}", st.thread_title
        stories.append(
            StoryIn(
                order=len(stories),
                thread=thread,
                thread_title_en=t_en,
                title_en=st.title.strip(),
                summary_en=st.summary.strip(),
                why_en=st.why.strip(),
                tag=st.tag,
                coverage=st.coverage,
                contested_en=st.contested.strip(),
                angles=[AngleIn(item_id=by_idx[a.ref].db_id, note_en=a.note.strip()) for a in st.angles],
                sources=[SourceRef(item_id=by_idx[r].db_id, is_primary=(r == st.ref)) for r in refs],
                posts=[by_idx[p].db_id for p in st.posts],
            )
        )
    return stories


_LATIN_WORD = re.compile(r"[A-Za-z]{3,}(?:[ .'-][A-Za-z]{2,})*")


def latin_words(text: str) -> list[str]:
    """Latin-script words inside Urdu text (outlet names, brands). Digits and short codes are fine."""
    return _LATIN_WORD.findall(text)


def apply_urdu(out: UrduOut, gw: GroupWork) -> None:
    gw.lead_ur = normalize_urdu(out.lead_ur, "latn")
    by_num = {u.idx: u for u in out.stories}
    for n, s in enumerate(gw.stories, 1):
        u = by_num.get(n)
        if not u:
            gw.errors.append(f"urdu: no output for story {n}")
            continue
        s.title_ur = normalize_urdu(u.title_ur, "latn")
        s.summary_ur = normalize_urdu(u.summary_ur, "latn")
        s.why_ur = normalize_urdu(u.why_ur, "latn")
        s.contested_ur = normalize_urdu(u.contested_ur, "latn")
        for a, note in zip(s.angles, u.angles_ur, strict=False):
            a.note_ur = normalize_urdu(note, "latn")
        if s.thread_title_en and not s.thread_title_ur:
            s.thread_title_ur = s.title_ur
        s.title_ur = s.title_ur.rstrip("۔. ")
        latin = latin_words(f"{s.title_ur} {s.summary_ur} {s.why_ur} {s.contested_ur}")
        if latin:
            gw.errors.append(f"urdu: Latin text in story {n}: {', '.join(dict.fromkeys(latin))[:120]}")
            logger.warning("%s: %s", gw.group.slug, gw.errors[-1])
    gw.glossary_additions = [
        {"term_en": g.term_en.strip(), "term_ur": normalize_urdu(g.term_ur, "latn"), "kind": g.kind}
        for g in out.glossary_additions
        if g.term_en.strip() and g.term_ur.strip()
    ]


def apply_qa(out: QaOut, gw: GroupWork) -> None:
    by_num = {q.n: q for q in out.stories}
    for n, s in enumerate(gw.stories, 1):
        q = by_num.get(n)
        if q:
            s.qa_status = q.status
            s.qa_note = q.note.strip()


# ---- the run ------------------------------------------------------------------------------------
@dataclass
class RunReport:
    run_id: str
    status: str
    edition_id: int | None = None
    publish_status: str | None = None
    stories: int = 0
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    out_file: str | None = None
    errors: list[str] = field(default_factory=list)
    backfill: bool = False
    passes: dict[str, dict[str, float]] = field(default_factory=dict)


PASS_KEYS = ("calls", "uncached", "cache_read", "cache_write", "tokens_in", "tokens_out", "cost_usd")


class EditionRun:
    def __init__(
        self,
        settings: Settings,
        api: WorkerApi,
        llm: LLM,
        fetcher: Fetcher,
        *,
        slot: str | None = None,
        date: str | None = None,
        groups: list[str] | None = None,
        dry_run: bool | None = None,
        now: datetime | None = None,
    ):
        self.s = settings
        self.api = api
        self.llm = llm
        self.fetcher = fetcher
        self.slot_override = slot
        self.date_override = date
        self.only_groups = set(groups or [])
        self.dry_run = settings.dry_run if dry_run is None else dry_run
        self.now = now or datetime.now(ZoneInfo(settings.tz))
        self.cost = 0.0
        self.tokens_in = 0
        self.tokens_out = 0
        self.models_used: list[str] = []
        self.passes: dict[str, dict[str, float]] = {}
        self._tail = _TailHandler()
        self._tail.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%H:%M:%S"))

    # ---- helpers ----------------------------------------------------------------------------
    def _account(self, res, pass_name: str) -> None:
        """Add one Claude call to the run totals. Each call's tokens_in already sums that query's API
        turns (a cached prompt is read again on every turn), so this is a plain sum: no call is
        counted twice and passes never overlap."""
        self.cost += res.cost_usd
        self.tokens_in += res.tokens_in
        self.tokens_out += res.tokens_out
        if res.model not in self.models_used:
            self.models_used.append(res.model)
        ps = self.passes.setdefault(pass_name, dict.fromkeys(PASS_KEYS, 0))
        ps["calls"] += 1
        ps["uncached"] += res.uncached
        ps["cache_read"] += res.cache_read
        ps["cache_write"] += res.cache_write
        ps["tokens_in"] += res.tokens_in
        ps["tokens_out"] += res.tokens_out
        ps["cost_usd"] = round(ps["cost_usd"] + res.cost_usd, 4)

    def _log_totals(self) -> None:
        parts = []
        for name, ps in self.passes.items():
            parts.append(
                f"{name}: {int(ps['calls'])} calls, in {int(ps['tokens_in'])} "
                f"({int(ps['uncached'])} uncached / {int(ps['cache_read'])} cache read / "
                f"{int(ps['cache_write'])} cache write), out {int(ps['tokens_out'])}, ${ps['cost_usd']:.4f}"
            )
        parts.append(f"total: in {self.tokens_in}, out {self.tokens_out}, ${self.cost:.4f}")
        logger.info("tokens per pass: " + "; ".join(parts))

    def _save_failed(self, info: SlotInfo, run_id: int | None, edition: EditionIn, additions, source_results) -> Path:
        """A finished edition that could not be delivered is written to out/failed-<run_id>.json so
        `teenpehr resubmit` can PUT and publish it later without calling Claude again."""
        path = self.s.out_dir / f"failed-{info.run_id}.json"
        path.write_text(
            json.dumps(
                {
                    "run_id": info.run_id,
                    "date": info.date,
                    "slot": info.slot,
                    "db_run_id": run_id,
                    "backfill": info.backfill,
                    "saved_at": datetime.now(UTC).isoformat(),
                    "edition": edition.model_dump(mode="json"),
                    "glossary_additions": list(additions.values()),
                    "sources": [r.model_dump(mode="json") for r in source_results],
                    "cost_usd": round(self.cost, 4),
                    "tokens_in": self.tokens_in,
                    "tokens_out": self.tokens_out,
                    "passes": self.passes,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        logger.error("delivery failed; edition saved to %s (teenpehr resubmit %s)", path, path)
        return path

    def _spend_today(self) -> float:
        f = self.s.state_dir / f"spend-{self.now:%Y-%m-%d}.json"
        try:
            return float(json.loads(f.read_text()).get("usd", 0.0))
        except (OSError, ValueError):
            return 0.0

    def _record_spend(self) -> None:
        f = self.s.state_dir / f"spend-{self.now:%Y-%m-%d}.json"
        with contextlib.suppress(OSError):
            f.write_text(json.dumps({"usd": round(self._spend_today() + self.cost, 4)}))

    # ---- main -------------------------------------------------------------------------------
    def run(self) -> RunReport:
        logging.getLogger().addHandler(self._tail)
        try:
            return self._run()
        finally:
            logging.getLogger().removeHandler(self._tail)

    def _run(self) -> RunReport:
        s = self.s
        self.api.health()
        config: Config = self.api.config()
        et = config.settings.edition_times.model_dump()
        info = resolve_slot(
            self.now,
            et,
            slot=self.slot_override,
            date=self.date_override,
            overlap_hours=s.overlap_hours,
            backfill_after_hours=s.backfill_after_hours,
            lookback_override=s.lookback_hours,
        )
        report = RunReport(run_id=info.run_id, status="running", backfill=info.backfill)
        logger.info(
            "run %s: window since %s (%.1f h), backfill=%s, dry_run=%s",
            info.run_id,
            info.since.isoformat(),
            info.lookback_hours,
            info.backfill,
            self.dry_run,
        )
        spent = self._spend_today()
        if spent >= s.daily_budget_usd:
            logger.error("daily budget reached ($%.2f >= $%.2f); skipping run", spent, s.daily_budget_usd)
            report.status = "skipped"
            return report

        wanted = self.only_groups
        groups = [g for g in sorted(config.groups, key=lambda g: g.order) if not wanted or g.slug in wanted]
        sources = [src for src in config.sources if src.group_id in {g.id for g in groups}]
        run_id: int | None = None if self.dry_run else self.api.start_run("edition", info.date, info.slot)

        try:
            # 1-2. collect + dedupe
            collector = Collector(s, self.fetcher, now=datetime.now(UTC))
            batches = collector.collect(sources, info.since)
            all_items = [it for b in batches for it in b.items]
            source_results = [b.result for b in batches]
            if not all_items:
                self._finish(run_id, "empty", source_results, error="no items could be fetched from any feed")
                report.status = "empty"
                return report

            # 3. persist items, learn which are new
            id_map: dict[str, tuple[int, bool]] = {}
            if self.dry_run:
                for n, it in enumerate(all_items, 1):
                    id_map[it.url_canonical] = (-n, True)
            else:
                for o in self.api.post_items(run_id, all_items):
                    id_map[o.url_canonical] = (o.id, o.is_new)

            # 4. build per-group numbered lists (articles then posts)
            works: list[GroupWork] = []
            for g in groups:
                arts: list[NumberedItem] = []
                for b in batches:
                    if b.source.group_id != g.id:
                        continue
                    for it in b.items:
                        db_id, is_new = id_map[it.url_canonical]
                        arts.append(
                            NumberedItem(
                                idx=0,
                                kind="article",
                                db_id=db_id,
                                title=it.title,
                                text=it.text,
                                source_name=b.source.name,
                                perspective=b.source.perspective,
                                lang=it.lang,
                                published=it.published_at,
                                url=it.url,
                                source_id=b.source.id,
                                is_new=is_new,
                            )
                        )
                arts = arts[:MAX_ARTICLES_PER_GROUP]
                posts: list[NumberedItem] = []
                try:
                    for p in self.api.get_posts(info.since, group=g.slug)[:MAX_POSTS_PER_GROUP]:
                        posts.append(
                            NumberedItem(
                                idx=0,
                                kind="post",
                                db_id=p.id,
                                title=p.text[:120],
                                text=p.text,
                                published=p.posted_at,
                                url=p.url,
                                author_handle=p.author_handle,
                                author_name=p.author_name,
                                is_repost=p.is_repost,
                            )
                        )
                except Exception as e:  # noqa: BLE001
                    logger.warning("%s: could not load posts: %s", g.slug, e)
                for n, it in enumerate(arts + posts, 1):
                    it.idx = n
                if arts:
                    works.append(GroupWork(group=g, articles=arts, posts=posts))
                else:
                    logger.info("%s: no articles this window", g.slug)

            # 5-7. Claude passes
            asyncio.run(self._editorial(works, config, info))

            # 8. assemble the edition
            edition = EditionIn(
                run_id=run_id,
                groups=[
                    EditionGroupIn(
                        group=w.group.slug,
                        lead_en=w.lead_en,
                        lead_ur=w.lead_ur,
                        item_count=len(w.articles),
                        stories=w.stories,
                    )
                    for w in works
                    if w.stories
                ],
            )
            report.stories = sum(len(g.stories) for g in edition.groups)
            report.errors = [e for w in works for e in w.errors]
            additions = {a["term_en"]: a for w in works for a in w.glossary_additions}

            if self.dry_run:
                out = s.out_dir / f"{info.run_id}.json"
                out.write_text(
                    json.dumps(
                        {
                            "run_id": info.run_id,
                            "since": info.since.isoformat(),
                            "backfill": info.backfill,
                            "sources": [r.model_dump(mode="json") for r in source_results],
                            "groups": {
                                w.group.slug: {
                                    "input": render_items(w.numbered),
                                    "fallback": w.fallback,
                                    "errors": w.errors,
                                }
                                for w in works
                            },
                            "edition": edition.model_dump(mode="json"),
                            "glossary_additions": list(additions.values()),
                            "cost_usd": round(self.cost, 4),
                            "tokens_in": self.tokens_in,
                            "tokens_out": self.tokens_out,
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                logger.info("DRY_RUN: wrote %s (%d stories, $%.4f)", out, report.stories, self.cost)
                report.status = "dry-run"
                report.out_file = str(out)
                report.cost_usd, report.tokens_in, report.tokens_out = self.cost, self.tokens_in, self.tokens_out
                report.passes = self.passes
                return report

            if not edition.groups:
                self._finish(run_id, "empty", source_results, error="no stories produced")
                report.status = "empty"
                return report

            # 9. publish; a finished edition is never lost if the web app fails here
            try:
                put = self.api.put_edition(info.date, info.slot, edition)
                report.edition_id = put.edition_id
                pub = self.api.publish(info.date, info.slot, notify=not info.backfill)
            except (ApiError, httpx.HTTPError):
                report.out_file = str(self._save_failed(info, run_id, edition, additions, source_results))
                self._record_spend()
                raise
            report.publish_status = pub.status
            logger.info("edition %s: %s (%d stories)", info.run_id, pub.status, report.stories)
            if additions:
                try:
                    res = self.api.add_glossary(list(additions.values()))
                    logger.info("glossary: %s", res)
                except Exception as e:  # noqa: BLE001
                    logger.warning("glossary update failed: %s", e)
            self._finish(run_id, "ok", source_results)
            self._record_spend()
            report.status = "ok"
            report.cost_usd, report.tokens_in, report.tokens_out = self.cost, self.tokens_in, self.tokens_out
            report.passes = self.passes
            if s.ntfy_on_success and not info.backfill:
                ntfy(s.ntfy_topic, f"{info.run_id} {pub.status}", f"{report.stories} stories, ${self.cost:.2f}")
            return report
        except Exception as e:
            msg = f"{type(e).__name__}: {str(e)[:400]}"
            logger.exception("run %s failed", info.run_id)
            if run_id is not None:
                try:
                    self._finish(run_id, "failed", [], error=msg)
                except Exception as e2:  # noqa: BLE001
                    logger.error("could not record failure: %s", e2)
            ntfy(s.ntfy_topic, f"{info.run_id} FAILED", msg, priority="high")
            report.status = "failed"
            report.errors.append(msg)
            raise

    def _finish(self, run_id: int | None, status: str, source_results: list[RunSourceResult], error: str | None = None):
        if run_id is None:
            return
        self.api.finish_run(
            run_id,
            RunFinish(
                status=status,  # type: ignore[arg-type]
                model=", ".join(self.models_used) or None,
                tokens_in=self.tokens_in,
                tokens_out=self.tokens_out,
                cost_usd=round(self.cost, 4),
                log="\n".join(self._tail.lines)[-200_000:],
                error=error,
                sources=source_results,
            ),
        )

    # ---- Claude passes ----------------------------------------------------------------------
    async def _editorial(self, works: list[GroupWork], config: Config, info: SlotInfo) -> None:
        s = self.s
        today = self.now.strftime("%A %d %B %Y, %H:%M %Z")
        known_threads = {t.slug for t in config.threads}
        threads_text = render_threads(config.threads)
        glossary_text = render_glossary(config.glossary)
        digits = "Western digits 0-9" if config.settings.digits_ur == "latn" else "Urdu digits ۰-۹"
        profile = (
            f"Readers of {config.settings.site_name_en}: families in Pakistan and the diaspora who want an honest "
            "picture of the world, not one outlet's spin. They do not care about celebrity news, sport or gadgets."
        )
        source_names = {i.db_id: i.source_name for w in works for i in w.articles}

        async def curate(w: GroupWork) -> None:
            system = load_prompt(
                "curate",
                profile=profile,
                group_name=w.group.name_en,
                brief=w.group.brief,
                count=w.group.story_count,
                today=today,
                threads=threads_text,
            )
            rendered = render_items(w.numbered, max_chars=s.prompt_item_chars)
            logger.info(
                "%s: %d articles + %d posts, prompt %d chars (uncapped would be %d)",
                w.group.slug,
                len(w.articles),
                len(w.posts),
                len(rendered),
                len(render_items(w.numbered, max_chars=100_000)),
            )
            user = f"Items for {w.group.name_en}:\n{rendered}"
            try:
                res = await self.llm.structured(
                    task=f"curate:{w.group.slug}",
                    system=system,
                    user=user,
                    schema=CurateOut,
                    model=s.news_model_curate,
                    max_budget_usd=s.budget_curate_usd,
                    effort=s.effort_curate,
                )
            except LLMError as e:
                w.errors.append(str(e))
                logger.error("%s: curation failed: %s", w.group.slug, e)
                w.fallback = True
                w.stories = fallback_stories(w, w.group.story_count)
                return
            self._account(res, "curate")
            w.lead_en = res.output.lead.strip()
            w.stories = curation_to_stories(res.output, w, known_threads, info.date)[: w.group.story_count]
            if not w.stories:
                w.errors.append("curation produced no usable stories")
                w.fallback = True
                w.stories = fallback_stories(w, w.group.story_count)

        async def urdu(w: GroupWork) -> None:
            if not w.stories or w.fallback:
                return
            system = load_prompt("urdu", glossary=glossary_text, digits=digits)
            user = render_stories_for_urdu(w.lead_en, w.stories, source_names)
            try:
                res = await self.llm.structured(
                    task=f"urdu:{w.group.slug}",
                    system=system,
                    user=user,
                    schema=UrduOut,
                    model=s.news_model_urdu,
                    max_budget_usd=s.budget_urdu_usd,
                    effort=s.effort_urdu,
                )
            except LLMError as e:
                w.errors.append(str(e))
                logger.error("%s: Urdu pass failed: %s", w.group.slug, e)
                return
            self._account(res, "urdu")
            apply_urdu(res.output, w)

        async def qa(w: GroupWork) -> None:
            if not w.stories or w.fallback:
                return
            system = load_prompt("qa")
            user = render_stories_for_qa(w.stories, w.by_db_id)
            try:
                res = await self.llm.structured(
                    task=f"qa:{w.group.slug}",
                    system=system,
                    user=user,
                    schema=QaOut,
                    model=s.news_model_qa,
                    max_budget_usd=s.budget_qa_usd,
                    effort=s.effort_qa,
                )
            except LLMError as e:
                w.errors.append(str(e))
                logger.error("%s: QA pass failed: %s", w.group.slug, e)
                return
            self._account(res, "qa")
            apply_qa(res.output, w)

        async def per_group(w: GroupWork) -> None:
            await curate(w)
            await urdu(w)
            await qa(w)

        await asyncio.gather(*(per_group(w) for w in works))
        self._log_totals()


# ---- resubmit a saved edition ------------------------------------------------------------------
def resubmit(api: WorkerApi, path: Path, *, publish: bool = True) -> dict:
    """PUT (and publish) an edition saved by `_save_failed`, without calling Claude. Item and post ids
    in the payload are server ids from the original run, so they stay valid. On success the file is
    renamed to resubmitted-<run_id>.json so it cannot be sent twice by accident."""
    data = json.loads(path.read_text(encoding="utf-8"))
    edition = EditionIn.model_validate(data["edition"])
    ids = [r.item_id for g in edition.groups for st in g.stories for r in st.sources]
    ids += [pid for g in edition.groups for st in g.stories for pid in st.posts]
    if any(i <= 0 for i in ids):
        raise ValueError(f"{path} holds placeholder ids from a dry run; it cannot be resubmitted")
    date, slot = data["date"], data["slot"]
    result: dict = {"run_id": data["run_id"], "put": None, "publish": None}
    try:
        put = api.put_edition(date, slot, edition)
        result["put"] = put.status
        result["edition_id"] = put.edition_id
    except ApiError as e:
        if e.status != 409:
            raise
        logger.warning("edition %s is already published on the server; skipping PUT", data["run_id"])
        result["put"] = "already-published"
    if publish:
        pub = api.publish(date, slot, notify=not data.get("backfill", False))
        result["publish"] = pub.status
        result["url"] = pub.url
    additions = data.get("glossary_additions") or []
    if additions:
        try:
            result["glossary"] = api.add_glossary(additions)
        except ApiError as e:
            logger.warning("glossary update failed: %s", e)
    done = path.with_name(path.name.replace("failed-", "resubmitted-", 1))
    path.rename(done)
    result["file"] = str(done)
    logger.info("resubmitted %s: %s", data["run_id"], result)
    return result
