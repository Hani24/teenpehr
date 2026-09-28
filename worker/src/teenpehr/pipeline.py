"""The edition run: collect → dedupe → curate (Claude) → Urdu (Claude) → QA (Claude) → publish.

Code does the fetching and bookkeeping; Claude only judges. A run is keyed by date+slot and is
idempotent on the server (the edition PUT upserts a draft until it is published or held for
review, and the run checks the edition before it spends anything). DRY_RUN makes no write at all:
no run row, no items, no edition, no saved feed validators, no image uploads; it writes
out/<run_id>.json (and the images' variants under out/<run_id>/images/) instead.

Claude's cost figures are API-equivalent (the CLI prices each call's tokens at API list prices);
the worker runs on the Claude Code login (llm.py), so they measure usage rather than a bill."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import threading
import time
import unicodedata
from collections import deque
from collections.abc import Callable, Mapping
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
from .fetch.http import Fetcher, FetchResult
from .images import ImagePicker, ItemRef, PostRef, item_ref, post_ref, reused_urls
from .llm import LLM, LLMError, LLMResult, load_prompt
from .models import (
    AngleIn,
    Config,
    CurateOut,
    EditionGroupIn,
    EditionIn,
    EditionTimes,
    EntityIn,
    GlossaryEntry,
    Group,
    ItemFetch,
    ItemIn,
    ItemRecord,
    LlmStory,
    QaOut,
    RunFinish,
    RunOutputIn,
    RunSourceResult,
    Source,
    SourceRef,
    StoredItem,
    StoryIn,
    Thread,
    UrduOut,
)
from .normalize import (
    canonical_url,
    content_hash,
    detect_lang,
    normalize_urdu,
    slugify,
    title_key,
    word_count,
)
from .notify import ntfy
from .render import (
    NumberedItem,
    block,
    clean_thread_title,
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
MAX_CATCHUP = 2  # slots that came due during a run and run right after it


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

    @property
    def until(self) -> datetime | None:
        """Upper end of the window. A backfill covers its slot as it stood at slot time, so it never
        pulls in news the next slot reports; an on-time run takes everything up to now."""
        return self.slot_at if self.backfill else None


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
    before the first slot of the day). The window starts at the previous slot minus the overlap.
    A date alone is refused: it would silently run (and publish) today's latest slot instead."""
    if date and not slot:
        raise ValueError(f"a date needs a slot: pass --slot with --date {date}")
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
    not_modified: bool = False  # the feed answered 304; its items are read back through `recover`
    recovered: set[str] = field(default_factory=set)  # url_canonical of the items read back that way
    # This feed's copies of articles another feed of the group claimed first (same URL). Not edited,
    # only sent to the API, so the sighting and a headline revision count for this feed too (D5).
    also_seen: list[ItemIn] = field(default_factory=list)


# The items the API already stores for one source (GET /items), for a feed that answered 304.
Recover = Callable[[Source], list[ItemRecord]]


def apply_article(it: ItemIn, art: article.Article) -> None:
    """Fold an article page into an item: its text when longer than the feed's, and the page's own
    metadata where the feed gave none (the page's site name wins over a feed title)."""
    if art.text and len(art.text) > len(it.text):
        it.text = art.text
        it.word_count = art.words
        it.lang_detected = detect_lang(f"{it.title} {art.text}")
        route = "germany" if art.route == "germany" else "direct"
        it.fetch = ItemFetch(route=route, status=art.status, ms=art.ms, via="article")
    if not art.status:
        return
    it.author = it.author or art.author
    it.site_name = art.site_name or it.site_name
    it.categories = list(dict.fromkeys(it.categories + art.categories))[:30]
    it.image_url = it.image_url or art.image_url
    it.description = it.description or art.description
    meta = art.meta()
    if meta:
        it.raw = {**(it.raw or {}), "article": meta}


def in_window(published: datetime | None, since: datetime, until: datetime | None) -> bool:
    """Undated entries are kept (the API's is_new=false stops repeats across runs), except in a
    bounded backfill window, where an undated entry cannot be placed and is most likely current."""
    if published is None:
        return until is None
    return published >= since and (until is None or published <= until)


class Collector:
    """Fetch every feed, keep what falls in the window, dedupe per group.

    Dedupe is per group: an article or wire headline carried by feeds of two groups belongs in both
    (each group cites the same item row), where one shared set would give it to whichever feed
    happened to answer first. A feed that answers 304 still contributes: its items come back from the
    API through `recover`. The fetcher's validators are saved by the run only after it has stored the
    items, and a backfill window never records any, so a 304 never hides items the server does not have."""

    def __init__(self, settings: Settings, fetcher: Fetcher, *, now: datetime, recover: Recover | None = None):
        self.s = settings
        self.fetcher = fetcher
        self.now = now
        self.recover = recover
        self._seen: dict[int, set[str]] = {}  # group_id -> dedupe keys
        self._seen_lock = threading.Lock()
        self._article_budget = settings.article_fetch_limit
        self._budget_lock = threading.Lock()
        # Article bodies go through robots.txt (read once per host this run) and its Crawl-delay.
        self.articles = article.ArticleFetcher(fetcher)

    def _claim(self, group_id: int, keys: list[str]) -> bool:
        with self._seen_lock:
            seen = self._seen.setdefault(group_id, set())
            if any(k in seen for k in keys):
                return False
            seen.update(keys)
            return True

    def _claimed(self, group_id: int, key: str) -> bool:
        with self._seen_lock:
            return key in self._seen.get(group_id, set())

    def _take_article_budget(self) -> bool:
        with self._budget_lock:
            if self._article_budget <= 0:
                return False
            self._article_budget -= 1
            return True

    def fetch_source(self, source: Source, since: datetime, until: datetime | None = None) -> SourceBatch:
        t0 = time.monotonic()
        result = RunSourceResult(source_id=source.id, ok=False, tier=1, route=source.route)
        try:
            # A bounded (backfill) window fetches in full and leaves the validators alone: it stores
            # nothing published after `until`, so validators it recorded would make the next on-time
            # run's 304 hide those entries, which the server never got.
            res = self.fetcher.get(source.url, route=source.route, conditional=until is None)
        except Exception as e:  # noqa: BLE001
            result.error = f"{type(e).__name__}: {str(e)[:200]}"
            result.ms = int((time.monotonic() - t0) * 1000)
            return SourceBatch(source, [], result)
        result.route = "germany" if res.route_used == "germany" else "direct"
        result.ms = res.ms
        if res.not_modified:
            result.ok = True
            return SourceBatch(source, [], result, not_modified=True)
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
            # Validators recorded for a body nothing came out of would make the next run's 304 hide
            # these items for good; the next run fetches the feed in full instead.
            forget = getattr(self.fetcher, "forget", None)  # duck-typed test fetchers may not have it
            if forget:
                forget(source.url)
            return SourceBatch(source, [], result)

        items: list[ItemIn] = []
        also_seen: list[ItemIn] = []
        candidates = [en for en in entries if en.link and in_window(en.published, since, until)]
        pos = 0
        while pos < len(candidates) and len(items) < source.max_items:
            # Only as many entries as can still be taken, so a Google News feed decodes (one page
            # fetch each, one batch POST) just what it keeps, plus any that turn out to be repeats.
            chunk = candidates[pos : pos + source.max_items - len(items)]
            pos += len(chunk)
            decoded: dict[str, str] = {}
            if source.kind == "gnews":
                decoded = gnews.decode_links([en.link for en in chunk], fetcher=self.fetcher, route=source.route)
            for en in chunk:
                title, link, text = en.title, en.link, en.summary
                if source.kind == "gnews":
                    title, link, text = gnews.clean_title(title), decoded.get(link, link), ""
                canon = canonical_url(link)
                tkey = title_key(title)
                if not tkey:
                    continue
                if not self._claim(source.group_id, [f"u:{canon}", f"t:{tkey}"]):
                    # Another feed of the group took this article (under parallel fetching, whichever
                    # answered first). This feed's copy still goes to the API as a sighting, so an item's
                    # own feed is compared for revisions on every run, not only on runs where it wins.
                    # A same-title article at another URL is a different item and is not sent.
                    if self._claimed(source.group_id, f"u:{canon}"):
                        also_seen.append(self._item(source, res, result.route, en, title, link, text, canon))
                    continue
                items.append(self._item(source, res, result.route, en, title, link, text, canon))
        # Short blurbs get the article body (bounded per run). A page robots.txt disallows, or a host
        # cooling down after a 429, is skipped before it costs any of the budget.
        for it in items:
            if len(it.text) >= SHORT_TEXT or source.kind == "youtube":
                continue
            try:
                if not self.articles.allowed(it.url, result.route):
                    continue
                if not self._take_article_budget():
                    break
                art = self.articles.fetch_article(it.url, route=result.route)
                if art is not None:
                    apply_article(it, art)
            except Exception as e:  # noqa: BLE001
                logger.debug("article fetch failed for %s: %s", it.url, e)
        result.ok = True
        result.items = len(items)
        result.ms = int((time.monotonic() - t0) * 1000)
        return SourceBatch(source, items, result, also_seen=also_seen)

    @staticmethod
    def _item(
        source: Source, res: FetchResult, route: str, en: rss.Entry, title: str, link: str, text: str, canon: str
    ) -> ItemIn:
        """One feed entry as an item to store (the research metadata of D5 included)."""
        text = text[:20_000]
        gn = source.kind == "gnews"
        return ItemIn(
            source_id=source.id,
            url=link,
            url_canonical=canon,
            title=title,
            text=text,
            published_at=en.published,
            lang=source.lang,
            content_hash=content_hash(canon, title),
            # research metadata (D5); a Google News entry's summary is only a list of links
            author=en.author,
            categories=en.categories,
            image_url=en.image_url,
            description=None if gn else en.description,
            word_count=word_count(text),
            lang_detected=detect_lang(f"{title} {text}"),
            guid=en.guid,
            feed_updated_at=en.updated,
            site_name=en.source_name or (None if gn else en.feed_title),
            fetch=ItemFetch(route=route, status=res.status, ms=res.ms, via=source.kind),
            raw=en.raw or None,
        )

    def _recover(self, b: SourceBatch, since: datetime, until: datetime | None) -> None:
        """Rebuild an unchanged (304) feed's items from what the API stored when it last changed.
        They keep the stored title and text (the article body already fetched then)."""
        if self.recover is None:
            return
        try:
            records = self.recover(b.source)
        except Exception as e:  # noqa: BLE001
            logger.warning("%s: feed unchanged, but its stored items could not be read: %s", b.source.name, e)
            return
        newest_first = sorted(records, key=lambda r: r.published_at or datetime.min.replace(tzinfo=UTC), reverse=True)
        for r in newest_first:
            if len(b.items) >= b.source.max_items:
                break
            if not in_window(r.published_at, since, until):
                continue
            # The server's own key, so the sighting lands on the stored row even if canonical_url() has
            # changed since it was stored; recomputed only for an older web app that does not send it.
            canon = r.url_canonical or canonical_url(r.url)
            tkey = title_key(r.title)
            if not tkey or not self._claim(b.source.group_id, [f"u:{canon}", f"t:{tkey}"]):
                continue
            b.items.append(
                ItemIn(
                    source_id=b.source.id,
                    url=r.url,
                    url_canonical=canon,
                    title=r.title,
                    text=r.text[:20_000],
                    published_at=r.published_at,
                    lang=r.lang,
                    content_hash=r.content_hash or content_hash(canon, r.title),
                    image_url=r.image_url,
                    fetch=ItemFetch(route=b.result.route, status=304, ms=b.result.ms, via=b.source.kind),
                )
            )
            b.recovered.add(canon)
        b.result.items = len(b.items)

    def collect(self, sources: list[Source], since: datetime, until: datetime | None = None) -> list[SourceBatch]:
        fetchable = [s for s in sources if s.kind in ("rss", "gnews", "youtube")]
        skipped = [s for s in sources if s not in fetchable]
        for s in skipped:
            logger.info("skipping %s: kind %s not fetchable by this worker yet", s.name, s.kind)
        ex = ThreadPoolExecutor(max_workers=self.s.fetch_workers)
        try:
            batches = list(ex.map(lambda s: self.fetch_source(s, since, until), fetchable))
        except BaseException:
            # Interrupted (SIGINT from systemd): drop the queued feeds so the run can record itself
            # before the stop timeout, instead of waiting for every remaining fetch.
            ex.shutdown(wait=False, cancel_futures=True)
            raise
        ex.shutdown()
        # A feed that timed out while eight others were in flight usually answers in seconds alone;
        # retry those once, sequentially, before calling them failed.
        for i, b in enumerate(batches):
            if b.timed_out:
                logger.info("%s: timed out, retrying once", b.source.name)
                retry = self.fetch_source(b.source, since, until)
                if retry.result.ok:
                    batches[i] = retry
        # Changed feeds have claimed their items first, so an unchanged feed never takes an item from one.
        for b in batches:
            if b.not_modified:
                self._recover(b, since, until)
        for b in batches:
            if b.not_modified:
                logger.info("%s: unchanged; %d stored items in the window", b.source.name, b.result.items)
            elif b.result.ok:
                logger.info("%s: %d items in %d ms via %s", b.source.name, b.result.items, b.result.ms, b.result.route)
            else:
                logger.warning("%s: FAILED %s", b.source.name, b.result.error)
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
    def by_ref(self) -> dict[tuple[str, int], NumberedItem]:
        """Articles and posts by (kind, db_id): their ids come from separate tables and overlap."""
        return {(i.kind, i.db_id): i for i in self.numbered}


def flag(story: StoryIn, note: str) -> None:
    """Hold a story for the editor. The publish route sends an edition with any flagged story to
    review instead of the front page; an unchecked story must never publish as "pending". Notes
    accumulate (the API keeps 1000 characters)."""
    story.qa_status = "flagged"
    story.qa_note = "; ".join(n for n in (story.qa_note, note.strip()) if n)[:1000]


def fallback_stories(gw: GroupWork, limit: int, *, digits: str = "latn", reason: str = "") -> list[StoryIn]:
    """Raw headlines, newest first, when the AI curation failed for a group.

    Each keeps the outlet's own words in the outlet's own language: an Urdu source fills the Urdu
    fields (its English fields only say where it comes from, since the API requires them), any other
    source fills the English ones. Nothing here was written or checked by the editorial passes, so
    every story is flagged and the edition waits for the editor instead of publishing unchecked."""
    ranked = sorted(gw.articles, key=lambda i: i.published or datetime.min.replace(tzinfo=UTC), reverse=True)
    note = "headline fallback, not written or checked by the editorial passes" + (f" ({reason})" if reason else "")
    stories: list[StoryIn] = []
    for n, it in enumerate(ranked[:limit]):
        body = it.text or it.title
        ref = [SourceRef(item_id=it.db_id, is_primary=True)]
        if it.lang == "ur":
            st = StoryIn(
                order=n,
                title_en=f"Urdu report from {it.source_name}",
                summary_en=f"{it.source_name} published this in Urdu; the original is linked.",
                title_ur=normalize_urdu(it.title, digits)[:300],
                summary_ur=normalize_urdu(body, digits)[:300],
                tag="skim",
                coverage="single-source",
                sources=ref,
            )
        else:
            st = StoryIn(
                order=n,
                title_en=it.title[:300],
                summary_en=body[:300],
                tag="skim",
                coverage="single-source",
                sources=ref,
            )
        flag(st, note)
        stories.append(st)
    return stories


# ---- research metadata (decision D5) --------------------------------------------------------------
MAX_KEYWORDS = 8
MAX_TOPICS = 3
MAX_PLACES = 10
MAX_COUNTRIES = 10
MAX_ENTITIES = 8
# ISO 3166-1 alpha-2 (iso-codes 4.x); the API checks only the shape, so the list is kept here.
_ISO_A2 = """AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT
    BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH
    ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT
    HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS
    LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI
    NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG
    SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG
    UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"""
ISO_COUNTRIES = frozenset(_ISO_A2.split())
_COUNTRY_ALIASES = {"UK": "GB", "EL": "GR"}
_DASHES = str.maketrans({"\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-"})


def fold(text: str) -> str:
    """Case-, quote-, dash- and spacing-insensitive form, for finding a name in item text."""
    text = unicodedata.normalize("NFKC", text).casefold().replace("\u2019", "'").replace("\u2018", "'")
    return " ".join(text.translate(_DASHES).split())


def mentioned(name: str, folded: str) -> bool:
    """Whether `name` occurs as whole words in text already passed through fold()."""
    n = fold(name)
    return len(n) >= 2 and re.search(rf"(?<!\w){re.escape(n)}(?!\w)", folded) is not None


def cited_text(gw: GroupWork, refs: list[int], posts: list[int]) -> str:
    """The folded titles and texts of the items a story cites: its articles, and its attached posts
    with their authors (a post is evidence of what its author said)."""
    by_idx = gw.by_idx
    parts = [f"{by_idx[i].title} \n {by_idx[i].text}" for i in refs if i in by_idx]
    parts += [f"{by_idx[i].author_name} @{by_idx[i].author_handle} \n {by_idx[i].text}" for i in posts if i in by_idx]
    return fold(" \n ".join(parts))


def story_metadata(st: LlmStory, cited: str) -> tuple[dict, list[str]]:
    """StoryIn research fields from a curated story, and the names dropped. Entities and places must
    occur in the cited items' own text (Claude may know a name the items never mention; such a name
    is not reported); keywords in the cited items or in the story as written. Topics and the event
    type are a classification, countries a code, so those are only checked against their lists."""
    own = fold(f"{st.title} {st.summary} {st.why} {st.contested}")
    dropped: list[str] = []
    entities: dict[str, EntityIn] = {}
    for e in st.entities:
        name = " ".join(e.name.split())[:200]
        if not name or fold(name) in entities:
            continue
        if not mentioned(name, cited):
            dropped.append(name)
            continue
        salience = round(min(1.0, max(0.0, e.salience)), 2)
        role = " ".join(e.role.split())[:40]
        entities[fold(name)] = EntityIn(name_en=name, kind=e.kind, role=role, salience=salience)
    places: list[str] = []
    for pl in st.places:
        pl = " ".join(pl.split())[:100]
        if not pl or pl in places:
            continue
        if mentioned(pl, cited):
            places.append(pl)
        else:
            dropped.append(pl)
    keywords: list[str] = []
    for k in st.keywords:
        k = " ".join(k.split())[:60]
        if k and fold(k) not in map(fold, keywords) and (mentioned(k, cited) or mentioned(k, own)):
            keywords.append(k)
    countries = []
    for c in st.countries:
        c = _COUNTRY_ALIASES.get(c.strip().upper(), c.strip().upper())
        if c in ISO_COUNTRIES and c not in countries:
            countries.append(c)
    meta = {
        "keywords": keywords[:MAX_KEYWORDS],
        "topics": list(dict.fromkeys(st.topics))[:MAX_TOPICS],
        "countries": countries[:MAX_COUNTRIES],
        "places": places[:MAX_PLACES],
        "event_type": st.event_type,
        "entities": sorted(entities.values(), key=lambda x: -(x.salience or 0))[:MAX_ENTITIES],
    }
    return meta, dropped


def curation_to_stories(out: CurateOut, gw: GroupWork, threads: Mapping[str, Thread], date: str) -> list[StoryIn]:
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
        # Thread titles are clamped to the API's 200 characters: one over-long title would fail the PUT
        # of the whole edition.
        thread, t_en = None, None
        if st.thread and st.thread in threads:
            thread = st.thread
            if not threads[thread].title_ur:  # an older thread with no Urdu title gets one from the Urdu pass
                t_en = clean_thread_title(threads[thread].title_en)
        elif st.thread_title and (title := clean_thread_title(st.thread_title)):
            # The model wrote it after reading untrusted items, and it is shown to every curate pass
            # for two weeks: one plain line, as short as a title (render.clean_thread_title).
            thread, t_en = f"{slugify(title)}-{date[:7]}", title
        meta, dropped = story_metadata(st, cited_text(gw, refs, st.posts))
        if dropped:
            logger.info("%s: '%s': left out names not in its items: %s", gw.group.slug, st.title[:40], dropped[:8])
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
                **meta,
            )
        )
    return stories


_LATIN_WORD = re.compile(r"[A-Za-z]{3,}(?:[ .'-][A-Za-z]{2,})*")
_ARABIC_LETTER = re.compile(r"[\u0620-\u064a\u0671-\u06d3]")


def latin_words(text: str) -> list[str]:
    """Latin-script words inside Urdu text (outlet names, brands). Digits and short codes are fine."""
    return _LATIN_WORD.findall(text)


def glossary_names(entries: list[GlossaryEntry], digits: str = "latn") -> dict[str, str]:
    """English term (folded) → Urdu spelling; an editor's locked spelling wins over a proposal."""
    ordered = sorted(entries, key=lambda e: e.locked)  # unlocked first, so locked ones overwrite
    return {fold(e.term_en): normalize_urdu(e.term_ur, digits) for e in ordered if e.term_ur.strip()}


def apply_urdu(out: UrduOut, gw: GroupWork, digits: str = "latn", glossary: Mapping[str, str] | None = None) -> None:
    """Copy the Urdu pass into the stories, normalised to Urdu code points and to the site's digit
    setting (`digits_ur`: "latn" 0-9 or "arabext" ۰-۹). A story the pass left out is flagged: it
    would show English to Urdu readers. Entity names take the glossary's spelling when it has one,
    else the pass's (only when it gave one per entity, in Urdu script)."""
    glossary = glossary or {}
    gw.lead_ur = normalize_urdu(out.lead_ur, digits)
    by_num = {u.idx: u for u in out.stories}
    for n, s in enumerate(gw.stories, 1):
        u = by_num.get(n)
        if not u or not u.title_ur.strip() or not u.summary_ur.strip():
            gw.errors.append(f"urdu: no output for story {n}")
            flag(s, "Urdu missing: the Urdu pass returned nothing for this story")
            continue
        s.title_ur = normalize_urdu(u.title_ur, digits).rstrip("۔. ")
        s.summary_ur = normalize_urdu(u.summary_ur, digits)
        s.why_ur = normalize_urdu(u.why_ur, digits)
        s.contested_ur = normalize_urdu(u.contested_ur, digits)
        for a, note in zip(s.angles, u.angles_ur, strict=False):
            a.note_ur = normalize_urdu(note, digits)
        if s.thread_title_en:
            # "" (not None) when the pass gave none: the API would otherwise name the whole thread
            # after this one story's headline; an empty Urdu title is filled by a later story.
            s.thread_title_ur = normalize_urdu(u.thread_title_ur, digits).rstrip("۔. ")[:200]
        names_ur = u.entities_ur if len(u.entities_ur) == len(s.entities) else []
        for i, e in enumerate(s.entities):
            name = glossary.get(fold(e.name_en)) or (normalize_urdu(names_ur[i], digits) if names_ur else "")
            if name and _ARABIC_LETTER.search(name) and not latin_words(name):
                e.name_ur = name[:200]
        latin = latin_words(f"{s.title_ur} {s.summary_ur} {s.why_ur} {s.contested_ur} {s.thread_title_ur or ''}")
        if latin:
            gw.errors.append(f"urdu: Latin text in story {n}: {', '.join(dict.fromkeys(latin))[:120]}")
            logger.warning("%s: %s", gw.group.slug, gw.errors[-1])
    gw.glossary_additions = [
        {"term_en": g.term_en.strip(), "term_ur": normalize_urdu(g.term_ur, digits), "kind": g.kind}
        for g in out.glossary_additions
        if g.term_en.strip() and g.term_ur.strip()
    ]


def apply_qa(out: QaOut, gw: GroupWork) -> None:
    """A story is verified only on an explicit "verified" verdict and only if nothing else flagged
    it; a story QA left out is flagged, never silently published."""
    by_num = {q.n: q for q in out.stories}
    for n, s in enumerate(gw.stories, 1):
        q = by_num.get(n)
        if q is None:
            flag(s, "not checked: QA returned no verdict for this story")
        elif q.status == "flagged":
            flag(s, q.note.strip()[:300] or "flagged by QA")
        elif s.qa_status != "flagged":
            s.qa_status = "verified"


# ---- the run ------------------------------------------------------------------------------------
@dataclass
class RunReport:
    """`status`: ok | dry-run | skipped (edition already published or held, or changed during the
    run) | budget (daily budget reached) | empty | failed | interrupted."""

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
    reason: str | None = None


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
        self.outputs: list[RunOutputIn] = []  # each successful Claude call's output, for POST /runs/{id}/outputs
        self._outputs_sent = 0  # how many of self.outputs _post_outputs has handed over (it runs twice)
        self._source_results: list[RunSourceResult] = []
        self._tail = _TailHandler()
        self._tail.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%H:%M:%S"))

    # ---- helpers ----------------------------------------------------------------------------
    def _account(self, res, pass_name: str, group: str | None = None, *, keep_output: bool = True) -> None:
        """Add one Claude call to the run totals (API-equivalent cost) and keep its output. Each call's
        tokens_in already sums that query's API turns (a cached prompt is read again on every turn), so
        this is a plain sum: no call is counted twice and passes never overlap. `keep_output` False for
        the image checks: the picker keeps their verdicts, failed checks included, and _images adds
        them to the outputs as stage "image"."""
        if keep_output:
            self.outputs.append(
                RunOutputIn(
                    group=group,
                    stage=pass_name,  # type: ignore[arg-type]
                    model=res.model,
                    tokens_in=res.tokens_in,
                    tokens_out=res.tokens_out,
                    cost_usd=round(res.cost_usd, 6),
                    output=res.output.model_dump(mode="json"),
                )
            )
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

    def _account_failure(self, e: LLMError, pass_name: str) -> None:
        """A failed call uses tokens too (up to the pass budget when it stopped there), so its cost
        counts towards the run and the daily ceiling; its output does not."""
        if not e.cost_usd:
            return
        self.cost += e.cost_usd
        ps = self.passes.setdefault(pass_name, dict.fromkeys(PASS_KEYS, 0))
        ps["cost_usd"] = round(ps["cost_usd"] + e.cost_usd, 4)

    def _log_totals(self) -> None:
        parts = []
        for name, ps in self.passes.items():
            parts.append(
                f"{name}: {int(ps['calls'])} calls, in {int(ps['tokens_in'])} "
                f"({int(ps['uncached'])} uncached / {int(ps['cache_read'])} cache read / "
                f"{int(ps['cache_write'])} cache write), out {int(ps['tokens_out'])}, ${ps['cost_usd']:.4f}"
            )
        parts.append(f"total: in {self.tokens_in}, out {self.tokens_out}, ${self.cost:.4f}")
        logger.info("tokens per pass (API-equivalent $): " + "; ".join(parts))

    def _save_failed(
        self, info: SlotInfo, run_id: int | None, edition: EditionIn, additions, source_results, *, publish: bool
    ) -> Path:
        """A finished edition that could not be delivered is written to out/failed-<run_id>.json so
        `teenpehr resubmit` can PUT and publish it later without calling Claude again. `publish` false
        (a --groups run that left the edition incomplete) makes resubmit leave it a draft, as the run did."""
        path = self.s.out_dir / f"failed-{info.run_id}.json"
        path.write_text(
            json.dumps(
                {
                    "run_id": info.run_id,
                    "date": info.date,
                    "slot": info.slot,
                    "db_run_id": run_id,
                    "backfill": info.backfill,
                    "publish": publish,
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
        """Add this run's Claude usage (API-equivalent dollars) to today's total. Called once per run,
        whatever the outcome (dry runs and interrupted runs included: their calls used tokens all the same)."""
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
            "run %s: window since %s%s (%.1f h), backfill=%s, dry_run=%s",
            info.run_id,
            info.since.isoformat(),
            f" until {info.until.isoformat()}" if info.until else "",
            info.lookback_hours,
            info.backfill,
            self.dry_run,
        )
        unknown = self.only_groups - {g.slug for g in config.groups}
        if unknown:
            raise ValueError(f"unknown group(s): {', '.join(sorted(unknown))}")

        # 0. An edition that is published or held for review is never redone: the PUT would refuse it
        # after the full Claude cost. An editor releases a hold in the admin to allow a rerun.
        state = self.api.get_edition(info.date, info.slot)
        if state and state.status in ("published", "review"):
            where = "already published" if state.status == "published" else "held for review"
            why = f"edition {info.run_id} is {where}"
            if not self.dry_run:
                logger.info("%s; nothing to do", why)
                self._record_skip(info)
                report.status, report.reason = "skipped", why
                return report
            logger.info("%s; dry run continues, nothing will be written", why)

        spent = self._spend_today()
        if spent >= s.daily_budget_usd:
            why = f"daily budget reached (${spent:.2f} of ${s.daily_budget_usd:.2f} API-equivalent)"
            logger.error("%s; %s gets no edition", why, info.run_id)
            if not self.dry_run:
                self._record_skip(info, error=why)
            ntfy(s.ntfy_topic, f"{info.run_id} SKIPPED", f"{why}; this slot has no edition", priority="high")
            report.status, report.reason = "budget", why
            report.errors.append(why)
            return report

        wanted = self.only_groups
        partial = bool(wanted)
        groups = [g for g in sorted(config.groups, key=lambda g: g.order) if not wanted or g.slug in wanted]
        slug_of = {g.id: g.slug for g in groups}
        sources = [src for src in config.sources if src.group_id in slug_of]
        run_id: int | None = None if self.dry_run else self.api.start_run("edition", info.date, info.slot)

        read_back: dict[str, list[ItemRecord]] = {}  # group slug -> GET /items, for 304 feeds

        def recover(src: Source) -> list[ItemRecord]:
            slug = slug_of[src.group_id]
            if slug not in read_back:  # one GET per group
                read_back[slug] = self.api.get_items(info.since, group=slug)
            return [r for r in read_back[slug] if r.source_id == src.id]

        try:
            # 1-2. collect + dedupe
            collector = Collector(s, self.fetcher, now=datetime.now(UTC), recover=recover)
            batches = collector.collect(sources, info.since, until=info.until)
            all_items = [it for b in batches for it in b.items]
            source_results = [b.result for b in batches]
            self._source_results = source_results
            if not all_items:
                return self._empty(report, run_id, info, "no items could be fetched from any feed")

            # 3. persist items, learn which are new. An article in two groups' feeds is one row; each
            # feed that carried it is sent, so the server records the sighting and a later 304 from
            # either feed can read the item back.
            first: dict[str, ItemIn] = {}
            sightings: dict[tuple[int, str], ItemIn] = {}
            for it in all_items:
                first.setdefault(it.url_canonical, it)
                sightings.setdefault((it.source_id, it.url_canonical), it)
            # A feed's copy of an article another feed of its group claimed first: a sighting only.
            for it in (d for b in batches for d in b.also_seen):
                if it.url_canonical in first:
                    sightings.setdefault((it.source_id, it.url_canonical), it)
            recovered = {c for b in batches for c in b.recovered}
            id_map: dict[str, tuple[int, bool]] = {}
            stored: dict[str, StoredItem] = {}
            if self.dry_run:
                for n, canon in enumerate(first, 1):
                    id_map[canon] = (-n, canon not in recovered)
            else:
                for o in self.api.post_items(run_id, list(sightings.values())):
                    id_map[o.url_canonical] = (o.id, o.is_new)
                    if o.stored:
                        stored[o.url_canonical] = o.stored
                # Conditional-GET validators are saved only now that the items behind them are stored,
                # so a later 304 can always read them back. Never on a dry run, which stores nothing.
                self.fetcher.save_state()
            # Claude sees what the item's row says, because that is what a story's citation shows: an
            # existing item keeps the title and text first stored (the outlet may have edited its
            # headline since), and a new one what was sent first (the server keeps the first copy).
            for it in all_items:
                row = stored.get(it.url_canonical) or first[it.url_canonical]
                if row is not it:
                    it.title, it.text, it.published_at = row.title, row.text, row.published_at

            # 4. build per-group numbered lists (articles then posts), and what the image step needs of them
            works: list[GroupWork] = []
            image_items: dict[int, ItemRef] = {}
            image_posts: dict[int, PostRef] = {}
            for g in groups:
                arts: list[NumberedItem] = []
                for b in batches:
                    if b.source.group_id != g.id:
                        continue
                    for it in b.items:
                        if it.url_canonical not in id_map:
                            logger.warning("%s: the API returned no id for %s; skipped", g.slug, it.url)
                            continue
                        db_id, is_new = id_map[it.url_canonical]
                        if db_id not in image_items:
                            image_items[db_id] = item_ref(db_id, it, b.source, b.result.route)
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
                        image_posts.setdefault(p.id, post_ref(p))
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

            # 5-7. Claude passes. Their outputs are kept on the server before anything else can fail.
            asyncio.run(self._editorial(works, config, info))
            if not self.dry_run:
                self._post_outputs(run_id)

            # 7b. publisher images for the stories, from what each cites (D6); never fails the run
            image_meta: list[dict] = []
            if s.images:
                image_meta = self._images(works, image_items, image_posts, all_items, collector, info)
                if not self.dry_run:
                    self._post_outputs(run_id)  # the image verdicts (stage "image")
            self._log_totals()

            # 8. assemble the edition (a --groups run replaces only its own groups on the server)
            edition = EditionIn(
                run_id=run_id,
                partial=partial,
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
            report.cost_usd, report.tokens_in, report.tokens_out = self.cost, self.tokens_in, self.tokens_out
            report.passes = self.passes

            if self.dry_run:
                out = s.out_dir / f"{info.run_id}.json"
                out.write_text(
                    json.dumps(
                        {
                            "run_id": info.run_id,
                            "since": info.since.isoformat(),
                            "until": info.until.isoformat() if info.until else None,
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
                            # what POST /images would have carried, pixels aside (files under images_dir)
                            "images": image_meta,
                            "images_dir": str(s.out_dir / info.run_id / "images") if image_meta else None,
                            "glossary_additions": list(additions.values()),
                            "cost_usd": round(self.cost, 4),
                            "tokens_in": self.tokens_in,
                            "tokens_out": self.tokens_out,
                            # what POST /items and POST /runs/{id}/outputs would have carried (D5 metadata)
                            "items": [it.model_dump(mode="json", exclude_none=True) for it in sightings.values()],
                            "outputs": [o.model_dump(mode="json") for o in self.outputs],
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                logger.info("DRY_RUN: wrote %s (%d stories, $%.4f API-equivalent)", out, report.stories, self.cost)
                report.status = "dry-run"
                report.out_file = str(out)
                return report

            if not edition.groups:
                return self._empty(report, run_id, info, "no stories produced")

            # 9. deliver; a finished edition is never lost if the web app fails here
            # A --groups run publishes only an edition that then has every group: publishing a draft that
            # lacks some (one this run created, or one built up by --groups runs) would put an incomplete
            # edition on the front page and lock the slot.
            missing: set[str] = set()
            if partial:
                have = set(state.groups) if state else set()
                missing = {g.slug for g in config.groups} - have - {g.group for g in edition.groups}
            publish = not missing
            pub = None
            try:
                put = self._put_edition(info, edition)
                report.edition_id = put.edition_id
                if publish:
                    pub = self.api.publish(info.date, info.slot, notify=not info.backfill)
                else:
                    logger.warning(
                        "edition %s after this --groups run lacks %s; left as a draft (run those with --groups, "
                        "or publish it in the admin)",
                        info.run_id,
                        ", ".join(sorted(missing)),
                    )
            except ApiError as e:
                if e.status == 409:
                    return self._conflict(report, run_id, info, e)
                saved = self._save_failed(info, run_id, edition, additions, source_results, publish=publish)
                report.out_file = str(saved)
                raise
            except httpx.HTTPError:
                saved = self._save_failed(info, run_id, edition, additions, source_results, publish=publish)
                report.out_file = str(saved)
                raise
            report.publish_status = pub.status if pub else "draft"
            logger.info("edition %s: %s (%d stories)", info.run_id, report.publish_status, report.stories)
            if additions:
                try:
                    res = self.api.add_glossary(list(additions.values()))
                    logger.info("glossary: %s", res)
                except Exception as e:  # noqa: BLE001
                    logger.warning("glossary update failed: %s", e)
            self._finish(run_id, "ok", source_results)
            report.status = "ok"
            if pub and pub.status == "review":
                ntfy(
                    s.ntfy_topic,
                    f"{info.run_id} held for review",
                    f"{pub.flagged or 0} of {report.stories} stories flagged; approve or release it in the admin",
                )
            elif s.ntfy_on_success and not info.backfill:
                summary = f"{report.stories} stories, ${self.cost:.2f}"
                ntfy(s.ntfy_topic, f"{info.run_id} {report.publish_status}", summary)
            return report
        except KeyboardInterrupt:
            # systemd stops the unit with SIGINT (manual stop or the TimeoutStartSec cap): record it.
            msg = "interrupted (SIGINT: the unit was stopped or hit its time limit)"
            logger.error("run %s %s", info.run_id, msg)
            self._finish_quietly(run_id, "failed", msg)
            ntfy(s.ntfy_topic, f"{info.run_id} INTERRUPTED", msg, priority="high")
            report.status = "interrupted"
            report.errors.append(msg)
            raise
        except Exception as e:
            msg = f"{type(e).__name__}: {str(e)[:400]}"
            logger.exception("run %s failed", info.run_id)
            self._finish_quietly(run_id, "failed", msg)
            ntfy(s.ntfy_topic, f"{info.run_id} FAILED", msg, priority="high")
            report.status = "failed"
            report.errors.append(msg)
            raise
        finally:
            self._record_spend()

    def _put_edition(self, info: SlotInfo, edition: EditionIn):
        """PUT the edition. Should the server refuse it over its images (an image id it does not know,
        or one it does not accept for its story), the edition goes again without images: a picture
        never costs a story, let alone the edition."""
        try:
            return self.api.put_edition(info.date, info.slot, edition)
        except ApiError as e:
            with_images = [st for g in edition.groups for st in g.stories if st.image_id is not None]
            if e.status != 400 or "image" not in e.message.lower() or not with_images:
                raise
            logger.warning("the edition PUT refused its images (%s); sending it without them", e.message)
            for st in with_images:
                st.image_id = None
            return self.api.put_edition(info.date, info.slot, edition)

    def _images(
        self,
        works: list[GroupWork],
        items: dict[int, ItemRef],
        posts: dict[int, PostRef],
        all_items: list[ItemIn],
        collector: Collector,
        info: SlotInfo,
    ) -> list[dict]:
        """Choose, check and deliver one image per story (images/picker.py). Uploads on a live run and
        sets each story's image_id; a dry run writes the variants under out/<run_id>/images/. Any
        failure here only leaves stories without images."""
        stories = [(w.group.slug, st) for w in works for st in w.stories]
        if not stories:
            return []
        t0 = time.monotonic()

        def account(res: LLMResult, task: str) -> None:
            self._account(res, "image_check", task.split(":")[1] if ":" in task else None, keep_output=False)

        picker: ImagePicker | None = None
        meta: list[dict] = []
        try:
            picker = ImagePicker(
                self.s,
                self.fetcher,
                collector.articles,  # robots.txt already read this run, same Crawl-delay spacing
                self.llm,
                account=account,
                account_failure=lambda e: self._account_failure(e, "image_check"),
                budget_ok=lambda: self._spend_today() + self.cost < self.s.daily_budget_usd,
                reused=reused_urls(all_items),  # a feed's stock picture: its URL on 3+ of its items
            )
            chosen = asyncio.run(picker.pick_all(stories, items, posts))
            out_dir = self.s.out_dir / info.run_id / "images" if self.dry_run else None
            meta = picker.deliver(chosen, api=None if self.dry_run else self.api, out_dir=out_dir)
        except Exception as e:  # noqa: BLE001 - images never fail the run
            logger.warning("images skipped after an error: %s: %s", type(e).__name__, e)
            for _, st in stories:
                st.image_id = None
            return []
        finally:
            if picker is not None:
                self._keep_verdicts(picker.verdicts, meta)
        graphic = sum(1 for m in meta if m["graphic"])
        extra = ", ".join(f"{k} {n}" for k, n in sorted(picker.stats.items()) if k != "shown")
        logger.info(
            "images: %d of %d stories (%d graphic) in %.0f s%s",
            len(meta),
            len(stories),
            graphic,
            time.monotonic() - t0,
            f"; {extra}" if extra else "",
        )
        return meta

    def _keep_verdicts(self, verdicts: list[dict], meta: list[dict]) -> None:
        """Each vision-check outcome as a stage "image" output: the verdict (or why there was none), the
        image's sha256 and address, and whether the story ended up showing it (`image_id` on a live run)."""
        shown = {(m["group"], m["order"], m["sha256"]): m for m in meta}
        for v in verdicts:
            m = shown.get((v["group"], v["order"], v["sha256"]))
            output = {
                k: v[k]
                for k in ("order", "sha256", "source_url", "graphic", "placeholder_or_logo", "checked", "reason")
            }
            output["shown"] = m is not None
            output["image_id"] = m.get("image_id") if m else None
            self.outputs.append(
                RunOutputIn(
                    group=v["group"],
                    stage="image",
                    model=v["model"],
                    tokens_in=v["tokens_in"],
                    tokens_out=v["tokens_out"],
                    cost_usd=v["cost_usd"],
                    output=output,
                )
            )

    def _post_outputs(self, run_id: int | None) -> None:
        """Keep each Claude call's output on the server (audits, prompt work): those not sent yet, so the
        image verdicts go in a request of their own after the editorial passes'. Best effort: the edition
        matters more than its audit trail, so a failure here is logged and the run goes on."""
        pending = self.outputs[self._outputs_sent :]
        self._outputs_sent = len(self.outputs)
        if run_id is None or not pending:
            return
        try:
            n = len(self.api.post_run_outputs(run_id, pending))
            logger.info("kept %d Claude outputs on the server", n)
        except Exception as e:  # noqa: BLE001
            logger.warning("could not keep the Claude outputs on the server: %s", e)

    def _record_skip(self, info: SlotInfo, error: str | None = None) -> None:
        """A run row for a run that stopped before collecting, so admin Runs shows every firing.
        Best effort: failing to record a skip must not turn it into a failed run."""
        try:
            self._finish(self.api.start_run("edition", info.date, info.slot), "skipped", [], error=error)
        except Exception as e:  # noqa: BLE001
            logger.warning("could not record the skipped run: %s", e)

    def _empty(self, report: RunReport, run_id: int | None, info: SlotInfo, why: str) -> RunReport:
        """The slot gets no edition. Nothing crashed, but somebody has to know: alert, and the CLI
        exits non-zero."""
        logger.error("%s: %s", info.run_id, why)
        self._finish(run_id, "empty", self._source_results, error=why)
        ntfy(self.s.ntfy_topic, f"{info.run_id} EMPTY", f"{why}; this slot has no edition", priority="high")
        report.status, report.reason = "empty", why
        report.errors.append(why)
        return report

    def _conflict(self, report: RunReport, run_id: int | None, info: SlotInfo, e: ApiError) -> RunReport:
        """The edition was published or held while this run worked (the check at the start passed).
        The server's edition is the one that counts; this run's work is dropped without a FAILED alert."""
        why = f"edition changed during the run: {e.message}"
        logger.warning("%s: %s; this run's edition was not delivered", info.run_id, why)
        self._finish(run_id, "skipped", self._source_results, error=why)
        ntfy(self.s.ntfy_topic, f"{info.run_id} not delivered", why)
        report.status, report.reason = "skipped", why
        return report

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

    def _finish_quietly(self, run_id: int | None, status: str, error: str) -> None:
        """Finish a failed run without raising over the original error. If the API refuses the
        per-source results (a source removed in the admin mid-run), record the run without them."""
        try:
            self._finish(run_id, status, self._source_results, error=error)
        except ApiError as e:
            if e.status != 400 or not self._source_results:
                logger.error("could not record failure: %s", e)
                return
            try:
                self._finish(run_id, status, [], error=error)
            except Exception as e2:  # noqa: BLE001
                logger.error("could not record failure: %s", e2)
        except Exception as e:  # noqa: BLE001
            logger.error("could not record failure: %s", e)

    # ---- Claude passes ----------------------------------------------------------------------
    async def _editorial(self, works: list[GroupWork], config: Config, info: SlotInfo) -> None:
        s = self.s
        today = self.now.strftime("%A %d %B %Y, %H:%M %Z")
        threads = {t.slug: t for t in config.threads}
        threads_text = render_threads(config.threads)
        digits_ur = config.settings.digits_ur
        digits = "Western digits 0-9" if digits_ur == "latn" else "Urdu digits ۰-۹"
        names_ur = glossary_names(config.glossary, digits_ur)
        profile = (
            f"Readers of {config.settings.site_name_en}: families in Pakistan and the diaspora who want an honest "
            "picture of the world, not one outlet's spin. They do not care about celebrity news, sport or gadgets."
        )

        async def curate(w: GroupWork) -> None:
            # Threads go in the user message with the items, never the system prompt: their titles
            # were written by a model that read untrusted items.
            system = load_prompt(
                "curate",
                profile=profile,
                group_name=w.group.name_en,
                brief=w.group.brief,
                count=w.group.story_count,
                today=today,
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
            user = (
                f"Existing developing-story threads (slug: title):\n{block('threads', threads_text)}\n\n"
                f"Items for {w.group.name_en}:\n{block('items', rendered)}"
            )
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
                self._account_failure(e, "curate")
                w.errors.append(str(e))
                logger.error("%s: curation failed: %s", w.group.slug, e)
                w.fallback = True
                w.stories = fallback_stories(w, w.group.story_count, digits=digits_ur, reason="curation failed")
                return
            self._account(res, "curate", w.group.slug)
            w.lead_en = res.output.lead.strip()
            w.stories = curation_to_stories(res.output, w, threads, info.date)[: w.group.story_count]
            if not w.stories:
                w.errors.append("curation produced no usable stories")
                w.fallback = True
                w.stories = fallback_stories(
                    w, w.group.story_count, digits=digits_ur, reason="curation produced no usable stories"
                )

        async def urdu(w: GroupWork) -> None:
            if not w.stories or w.fallback:
                return
            names = {i.db_id: i.source_name for i in w.articles}
            user = render_stories_for_urdu(w.lead_en, w.stories, names)
            # Every locked spelling, plus the unreviewed proposals this group's stories actually mention.
            system = load_prompt("urdu", glossary=render_glossary(config.glossary, text=user), digits=digits)
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
                self._account_failure(e, "urdu")
                w.errors.append(str(e))
                logger.error("%s: Urdu pass failed: %s", w.group.slug, e)
                for st in w.stories:
                    flag(st, f"Urdu missing: the Urdu pass failed ({str(e)[:200]})")
                return
            self._account(res, "urdu", w.group.slug)
            apply_urdu(res.output, w, digits_ur, names_ur)

        async def qa(w: GroupWork) -> None:
            if not w.stories or w.fallback:
                return  # fallback stories are flagged already
            system = load_prompt("qa")
            user = render_stories_for_qa(w.stories, w.by_ref)
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
                self._account_failure(e, "qa")
                w.errors.append(str(e))
                logger.error("%s: QA pass failed: %s", w.group.slug, e)
                for st in w.stories:
                    flag(st, f"not checked: the QA pass failed ({str(e)[:200]})")
                return
            self._account(res, "qa", w.group.slug)
            apply_qa(res.output, w)

        async def per_group(w: GroupWork) -> None:
            await curate(w)
            await urdu(w)
            await qa(w)

        await asyncio.gather(*(per_group(w) for w in works))


# ---- catch-up and the timer ----------------------------------------------------------------------
SCHEDULE_STATE = "schedule.json"
_SCHEDULE_KEEP = timedelta(days=7)


class ConfigError(RuntimeError):
    """The worker is not set up to run a slot that is due (the CLI exits 2)."""


class _Schedule:
    """What the timer has done, in the state directory: the slots it started (each is started once,
    whatever the outcome), the slots it could not start (web app down, Claude Code not signed in:
    alerted once, then retried quietly), and the last edition times it read, for deciding whether
    anything is due while the app is down."""

    def __init__(self, settings: Settings, now: datetime):
        self.path = settings.state_dir / SCHEDULE_STATE
        self.now = now
        try:
            raw = json.loads(self.path.read_text())
        except (OSError, ValueError):
            raw = {}
        raw = raw if isinstance(raw, dict) else {}
        self.times: dict[str, str] = raw.get("times") if isinstance(raw.get("times"), dict) else {}
        self.started = self._times(raw.get("started"))
        self.blocked = self._times(raw.get("blocked"))

    def _times(self, value) -> dict[str, datetime]:
        out: dict[str, datetime] = {}
        for k, v in (value if isinstance(value, dict) else {}).items():
            with contextlib.suppress(TypeError, ValueError):
                out[str(k)] = datetime.fromisoformat(str(v))
        return out

    def _recent(self, d: dict[str, datetime]) -> dict[str, str]:
        return {k: v.isoformat() for k, v in d.items() if self.now - v < _SCHEDULE_KEEP}

    def save(self) -> None:
        data = {
            "times": self.times,
            "started": self._recent(self.started),
            "blocked": self._recent(self.blocked),
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, sort_keys=True))
            tmp.replace(self.path)
        except OSError as e:
            logger.warning("could not save %s: %s", self.path.name, e)

    def start(self, run_id: str) -> None:
        """Recorded before the run, so a crash or a timeout never makes the timer pay for it twice."""
        self.started[run_id] = self.now
        self.save()

    def block(self, run_id: str) -> bool:
        """A due slot that cannot start yet. True the first time, when the firing should fail (the
        unit's OnFailure alert); later firings wait quietly and run it once the cause is fixed."""
        if run_id in self.blocked:
            return False
        self.blocked[run_id] = self.now
        self.save()
        return True


def run_editions(
    settings: Settings,
    api: WorkerApi,
    llm: LLM | None,
    fetcher: Fetcher,
    *,
    slot: str | None = None,
    date: str | None = None,
    groups: list[str] | None = None,
    dry_run: bool | None = None,
    scheduled: bool = False,
    max_catchup: int = MAX_CATCHUP,
    clock: Callable[[], datetime] | None = None,
) -> list[RunReport]:
    """Run the requested edition; after an automatic live run, look at the clock again.

    A slot that came due while the run worked had its timer fire while the unit was still busy,
    and systemd drops such a firing, so it runs now (at most `max_catchup` more): a catch-up never
    swallows the next slot. Each run checks its edition first, so a slot already published is only
    a skip. Explicit --slot/--date/--groups runs and dry runs do exactly what was asked.

    `scheduled` (the systemd timer, every few minutes): the latest slot that is due by the edition
    times in the admin settings runs once; a firing that finds it already started does nothing
    (no run row, no Claude), so the settings alone decide when editions are made. Whether Claude can
    run (the Claude Code CLI signed in, `llm.auth_problem()`) is asked only once a slot is due: a
    firing with nothing due never starts the CLI, and a due slot the CLI cannot serve fails once
    (the unit's alert), then waits quietly until it can."""
    clock = clock or (lambda: datetime.now(ZoneInfo(settings.tz)))
    now = clock()
    sched = _Schedule(settings, now) if scheduled else None
    if sched is not None:
        info = _due_slot(settings, api, sched, now)
        if info is None:
            return []
        problem = _llm_problem(llm)
        if problem:
            msg = f"{info.run_id} is due, but {problem}"
            if sched.block(info.run_id):
                raise ConfigError(msg)
            logger.warning("%s; it runs once Claude is available", msg)
            return []
        sched.start(info.run_id)
        slot, date = info.slot, info.date
    problem = _llm_problem(llm)
    if problem:
        raise ConfigError(problem)
    assert llm is not None
    first = EditionRun(settings, api, llm, fetcher, slot=slot, date=date, groups=groups, dry_run=dry_run, now=now)
    reports = [first.run()]
    if sched is None and (slot or date or groups or first.dry_run):
        return reports
    for _ in range(max_catchup):
        if reports[-1].status == "budget":
            break  # the next slot would be skipped for the same reason
        now = clock()
        try:
            nxt = resolve_slot(now, api.config().settings.edition_times.model_dump())
        except Exception as e:  # noqa: BLE001 - the run that finished must not turn into a failure here
            msg = f"could not check whether another slot came due during the run: {type(e).__name__}: {e}"
            logger.error(msg)
            ntfy(settings.ntfy_topic, "catch-up check failed", msg)
            break
        if nxt.run_id in {r.run_id for r in reports}:
            break
        if sched is not None:
            if nxt.run_id in sched.started:
                break
            sched.now = now
            sched.start(nxt.run_id)
        logger.info("slot %s came due during the last run; running it now", nxt.run_id)
        run = EditionRun(settings, api, llm, fetcher, slot=nxt.slot, date=nxt.date, dry_run=dry_run, now=now)
        reports.append(run.run())
    return reports


def _llm_problem(llm: LLM | None) -> str | None:
    """Why no Claude call can be made (the CLI missing or not signed in), or None."""
    if llm is None:
        return NO_CLAUDE
    check = getattr(llm, "auth_problem", None)
    return check() if callable(check) else None


NO_CLAUDE = "Claude is not available (the Claude Code CLI could not be set up)"


def _due_slot(settings: Settings, api: WorkerApi, sched: _Schedule, now: datetime) -> SlotInfo | None:
    """The slot a timer firing should run, or None when the latest due slot was already started.

    The edition times come from the admin settings. When the web app does not answer, the times
    last read decide whether a slot is due: if one is, the firing fails (one alert per slot, from
    systemd's OnFailure), and later firings keep trying quietly until the app is back."""
    try:
        times = api.config().settings.edition_times.model_dump()
    except (ApiError, httpx.HTTPError) as e:
        info = resolve_slot(now, sched.times or EditionTimes().model_dump())
        if info.run_id in sched.started:
            logger.warning("web app unreachable (%s); %s already ran", e, info.run_id)
            return None
        if sched.block(info.run_id):
            raise
        logger.warning("web app still unreachable (%s); %s waits for it", e, info.run_id)
        return None
    if times != sched.times:
        sched.times = times
        sched.save()
    info = resolve_slot(
        now,
        times,
        overlap_hours=settings.overlap_hours,
        backfill_after_hours=settings.backfill_after_hours,
        lookback_override=settings.lookback_hours,
    )
    if info.run_id in sched.started:
        logger.debug("%s already ran; nothing is due", info.run_id)
        return None
    return info


# ---- resubmit a saved edition ------------------------------------------------------------------
def resubmit(api: WorkerApi, path: Path, *, publish: bool = True) -> dict:
    """PUT (and publish) an edition saved by `_save_failed`, without calling Claude. Item and post ids
    in the payload are server ids from the original run, so they stay valid. On success the file is
    renamed to resubmitted-<run_id>.json so it cannot be sent twice by accident. An edition held for
    review is refused: the editor owns it until the hold is released in the admin. A file saved with
    "publish": false (a --groups run that left the edition incomplete) is only PUT, never published."""
    data = json.loads(path.read_text(encoding="utf-8"))
    edition = EditionIn.model_validate(data["edition"])
    ids = [r.item_id for g in edition.groups for st in g.stories for r in st.sources]
    ids += [pid for g in edition.groups for st in g.stories for pid in st.posts]
    if any(i <= 0 for i in ids):
        raise ValueError(f"{path} holds placeholder ids from a dry run; it cannot be resubmitted")
    date, slot = data["date"], data["slot"]
    held = f"edition {data['run_id']} is held for review; release the hold in the admin before resubmitting"
    result: dict = {"run_id": data["run_id"], "put": None, "publish": None}
    state = api.get_edition(date, slot)
    if state and state.status == "review":
        raise ValueError(held)
    if state and state.status == "published":
        logger.warning("edition %s is already published on the server; skipping PUT", data["run_id"])
        result["put"] = "already-published"
    else:
        try:
            put = api.put_edition(date, slot, edition)
            result["put"] = put.status
            result["edition_id"] = put.edition_id
        except ApiError as e:
            if e.status != 409:
                raise
            if "review" in e.message:
                raise ValueError(held) from None
            logger.warning("edition %s is already published on the server; skipping PUT", data["run_id"])
            result["put"] = "already-published"
    if publish and data.get("publish") is False:
        logger.warning("edition %s was left incomplete by a --groups run; left as a draft", data["run_id"])
        result["publish"] = "left-as-draft"
    elif publish:
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
