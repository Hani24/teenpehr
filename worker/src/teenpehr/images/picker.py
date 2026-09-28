"""One publisher image per story (decision D6): chosen only from what the story cites, downloaded
once through the run's Fetcher, cleaned and re-encoded (process.py), checked by a small vision call
through Claude Code, then uploaded to the web app (or written to out/ on a dry run).

Order of candidates for a story: the primary cited item's lead image (the feed's media, or the
image its article page gave during collection), then that page's og:image / twitter:image /
schema.org image when the page was not read yet, then the other cited items the same way, then the
first photo of each cited X post. Never an uncited item, never a Google News wrapper page (a Google
News item's page is its decoded publisher URL), never an image a feed reuses for three or more of
its items in this run (a site's stock picture), never the same picture on two stories.

Downloads: at most two at a time over the whole run, and one per host (the Fetcher's host lock);
robots.txt and Crawl-delay of the image's host are honoured, a host cooling down after a 429 is skipped, every
redirect hop must be a public address, the body is capped at 8 MB, only image/* (never SVG). The
publisher's article URL goes as the Referer. Nothing here can fail a story or the run: every
problem is logged and the story simply has no image, and past settings.image_time_limit_s no new
download starts."""

from __future__ import annotations

import asyncio
import base64
import threading
import time
from collections import Counter
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import log
from ..llm import LLM, ImageBlock, LLMError, LLMResult, load_prompt
from ..models import ImageCheckOut, ImageIn, ImageVariantIn, ItemIn, PostRecord, Source, StoryIn
from .page import is_google_host, page_images, usable_image_url
from .process import MAX_DOWNLOAD_BYTES, ImageRejected, Processed, process_image

if TYPE_CHECKING:
    from ..api import WorkerApi
    from ..config import Settings
    from ..fetch.article import ArticleFetcher
    from ..fetch.http import Fetcher

logger = log.get("images")

DOWNLOADS_AT_ONCE = 2
CHECKS_AT_ONCE = 3  # vision calls in flight (each one starts a Claude Code CLI)
CHECK_TIMEOUT_S = 90.0  # a call that has not answered by then counts as failed: graphic
MAX_DOWNLOADS_PER_STORY = 4
MAX_PAGES_PER_STORY = 2
MAX_CHECKS_PER_STORY = 2
REUSE_THRESHOLD = 3  # a feed's image URL on this many of its items in one run is its stock picture
# What a browser sends for an <img>; the navigation-only headers are dropped (None).
IMAGE_HEADERS: dict[str, str | None] = {
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": None,
    "Upgrade-Insecure-Requests": None,
}
CHECK_USER = "Check this image, which a news site published with one of its stories."


@dataclass
class ItemRef:
    """What the picker needs of a cited article."""

    db_id: int
    url: str
    source_id: int | None
    credit: str  # the outlet's name as the story shows it
    route: str = "direct"
    kind: str = "rss"
    image_urls: list[str] = field(default_factory=list)  # feed media, then the page's own (collection)
    page_fetched: bool = False  # the article page was read during collection (its image is in image_urls)


@dataclass
class PostRef:
    db_id: int
    url: str
    credit: str  # the author's display name
    photo_url: str | None = None
    photo_alt: str | None = None


@dataclass
class Candidate:
    url: str
    referer: str
    route: str
    alt: str | None
    item: ItemRef | None = None
    post: PostRef | None = None

    @property
    def source_id(self) -> int | None:
        return self.item.source_id if self.item else None


@dataclass
class Chosen:
    group: str
    story: StoryIn
    image: Processed
    cand: Candidate
    graphic: bool
    checked: bool  # the vision check ran and answered
    image_id: int | None = None
    files: list[str] = field(default_factory=list)

    def to_api(self) -> ImageIn:
        c = self.cand
        return ImageIn(
            sha256=self.image.sha256,
            source_url=c.url,
            item_id=c.item.db_id if c.item else None,
            post_id=c.post.db_id if c.post else None,
            source_id=c.item.source_id if c.item else None,
            credit=" ".join((c.item or c.post).credit.split())[:120],  # type: ignore[union-attr]
            alt=c.alt,
            graphic=self.graphic,
            color=self.image.color,
            width=self.image.width,
            height=self.image.height,
            variants=[
                ImageVariantIn(w=v.w, h=v.h, data_base64=base64.b64encode(v.data).decode("ascii"))
                for v in self.image.variants
            ],
        )

    def meta(self) -> dict[str, Any]:
        """What the dry-run file records (the upload minus the pixels)."""
        c = self.cand
        return {
            "group": self.group,
            "order": self.story.order,
            "image_id": self.image_id,
            "item_id": c.item.db_id if c.item else None,
            "post_id": c.post.db_id if c.post else None,
            "source_id": c.item.source_id if c.item else None,
            "source_url": c.url,
            "credit": (c.item or c.post).credit,  # type: ignore[union-attr]
            "alt": c.alt,
            "graphic": self.graphic,
            "checked": self.checked,
            "sha256": self.image.sha256,
            "color": self.image.color,
            "width": self.image.width,
            "height": self.image.height,
            "source_format": self.image.source_format,
            "variants": [{"w": v.w, "h": v.h, "bytes": v.bytes} for v in self.image.variants],
            "files": self.files,
        }


# ---- what the run knows about cited items and posts ------------------------------------------------
def item_ref(db_id: int, it: ItemIn, source: Source, route: str) -> ItemRef:
    """An item as the picker sees it. A Google News item's feed image is Google's, never the
    publisher's, so only the image its publisher page gave is kept; its credit is the outlet the
    entry names rather than the Google News feed."""
    art = (it.raw or {}).get("article") if isinstance(it.raw, dict) else None
    art = art if isinstance(art, dict) else {}
    urls = [u for u in (it.image_url, art.get("image_url")) if isinstance(u, str) and u]
    if source.kind == "gnews":
        urls = [u for u in urls if not is_google_host(u)]
    credit = (it.site_name if source.kind == "gnews" and it.site_name else source.name) or source.name
    return ItemRef(
        db_id=db_id,
        url=it.url,
        source_id=source.id,
        credit=credit,
        route=route,
        kind=source.kind,
        image_urls=list(dict.fromkeys(urls)),
        page_fetched=bool(art) or bool(it.fetch and it.fetch.via == "article"),
    )


def post_ref(p: PostRecord) -> PostRef:
    """A post and its first photo (a video's still is not a photo the post published)."""
    photo = next((m for m in p.media or [] if m.type == "photo" and usable_image_url(m.url)), None)
    return PostRef(
        db_id=p.id,
        url=p.url,
        credit=p.author_name.strip() or f"@{p.author_handle}",
        photo_url=photo.url if photo else None,
        photo_alt=photo.alt if photo else None,
    )


def reused_urls(items: list[ItemIn], threshold: int = REUSE_THRESHOLD) -> set[tuple[int, str]]:
    """(source_id, image URL) pairs a feed attached to `threshold` or more of its items in this run."""
    counts: Counter[tuple[int, str]] = Counter()
    for it in items:
        art = (it.raw or {}).get("article") if isinstance(it.raw, dict) else None
        urls = {it.image_url, art.get("image_url") if isinstance(art, dict) else None} - {None, ""}
        for u in urls:
            counts[(it.source_id, str(u))] += 1
    return {k for k, n in counts.items() if n >= threshold}


# ---- the picker ------------------------------------------------------------------------------------
class ImagePicker:
    """One run's image work. `account` / `account_failure` add a vision call to the run's usage;
    `budget_ok` says whether today's usage ceiling still allows another call."""

    def __init__(
        self,
        settings: Settings,
        fetcher: Fetcher,
        articles: ArticleFetcher,
        llm: LLM,
        *,
        account: Callable[[LLMResult, str], None],
        account_failure: Callable[[LLMError], None],
        budget_ok: Callable[[], bool],
        reused: set[tuple[int, str]] | None = None,
    ):
        self.s = settings
        self.fetcher = fetcher
        self.articles = articles
        self.llm = llm
        self.account = account
        self.account_failure = account_failure
        self.budget_ok = budget_ok
        self.reused = reused or set()
        self._page_budget = settings.image_page_fetch_limit
        self._budget_lock = threading.Lock()
        self._sem: asyncio.Semaphore | None = None
        self._check_sem: asyncio.Semaphore | None = None
        self._system = load_prompt("image_check")
        self.stats: Counter[str] = Counter()
        self._budget_logged = False
        self._deadline: float | None = None  # set by pick_all: settings.image_time_limit_s from its start
        self._late_logged = False
        # One entry per vision-check outcome (answered, failed, timed out, not run), in the order they came:
        # the run keeps them as "image" outputs, so why a picture was blurred or dropped can be looked up.
        self.verdicts: list[dict[str, Any]] = []

    # ---- candidates ---------------------------------------------------------------------------
    @staticmethod
    def owners(story: StoryIn, items: dict[int, ItemRef], posts: dict[int, PostRef]) -> list[ItemRef | PostRef]:
        """The cited items (primary first, then the rest in citation order), then the cited posts."""
        refs = sorted(story.sources, key=lambda r: not r.is_primary)
        out: list[ItemRef | PostRef] = [items[r.item_id] for r in refs if r.item_id in items]
        out += [posts[p] for p in story.posts if p in posts]
        return list({(type(o).__name__, o.db_id): o for o in out}.values())

    def _known(self, item: ItemRef) -> Iterator[Candidate]:
        for u in item.image_urls:
            if not usable_image_url(u):
                continue
            if (item.source_id, u) in self.reused:
                self.stats["stock picture"] += 1
                logger.debug("skipping %s: its feed uses it for %d+ items this run", u, REUSE_THRESHOLD)
                continue
            yield Candidate(u, item.url, item.route, None, item=item)

    def _late(self, task: str) -> bool:
        """Whether the image step is past its time limit, so no new page read or download may start."""
        if self._deadline is None or time.monotonic() < self._deadline:
            return False
        self.stats["time limit"] += 1
        if not self._late_logged:
            logger.warning(
                "%s: the image step reached its %.0f s limit; stories still waiting get no image",
                task,
                self.s.image_time_limit_s,
            )
            self._late_logged = True
        return True

    def _take_page_budget(self) -> bool:
        with self._budget_lock:
            if self._page_budget <= 0:
                return False
            self._page_budget -= 1
            return True

    def _from_page(self, item: ItemRef) -> list[Candidate]:
        """Read the article page (robots.txt, Crawl-delay, one per host) for the image it declares."""
        if item.page_fetched or item.kind == "youtube" or is_google_host(item.url):
            return []
        if not self.articles.allowed(item.url, item.route):
            return []
        if not self._take_page_budget():
            self.stats["page budget spent"] += 1
            return []
        item.page_fetched = True  # one read per item, whichever story cites it
        page = self.articles.fetch_page(item.url, route=item.route)
        if page is None or not page.ok:
            return []
        ctype = page.headers.get("content-type", "").lower()
        if ctype and "html" not in ctype:
            return []
        base = page.final_url or item.url
        return [Candidate(p.url, item.url, item.route, p.alt, item=item) for p in page_images(page.content, base)]

    # ---- download ------------------------------------------------------------------------------
    def download(self, cand: Candidate) -> bytes:
        """The image's bytes as served, or ImageRejected. Runs in a worker thread."""
        if not usable_image_url(cand.url):
            raise ImageRejected("not a usable image URL")
        if not self.articles.allowed(cand.url, cand.route):
            raise ImageRejected("robots.txt disallows it, or its host is cooling down after a 429")
        # Through the ArticleFetcher, so the image host's Crawl-delay spaces these requests like its
        # pages (the article page and its image are often on one host, fetched back to back).
        res = self.articles.fetch_page(
            cand.url,
            route=cand.route,
            # an article URL with a control character (never expected) is not put in a header
            headers={**IMAGE_HEADERS, "Referer": cand.referer if cand.referer.isprintable() else None},
            allow_fallback=False,
            max_bytes=MAX_DOWNLOAD_BYTES,
            hard_limit=True,
        )
        if res is None:
            raise ImageRejected("robots.txt disallows it, or its Crawl-delay is too long for this run")
        if not res.ok:
            raise ImageRejected(res.error or f"http {res.status}")
        ctype = res.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if not ctype.startswith("image/") or "svg" in ctype:
            raise ImageRejected(f"content type {ctype or 'missing'!r}")
        return res.content

    def _fetch_and_process(self, cand: Candidate) -> Processed:
        return process_image(self.download(cand))

    # ---- vision check --------------------------------------------------------------------------
    def _verdict(
        self,
        task: str,
        img: Processed,
        url: str,
        answer: tuple[bool, bool, bool],
        reason: str,
        res: LLMResult | None = None,
        cost_usd: float = 0.0,
    ) -> tuple[bool, bool, bool]:
        """Record one check outcome (self.verdicts) and hand the answer back."""
        _, group, order = (task.split(":", 2) + ["", ""])[:3]
        graphic, placeholder, checked = answer
        self.verdicts.append(
            {
                "group": group or None,
                "order": int(order) if order.isdigit() else None,
                "sha256": img.sha256,
                "source_url": url,
                "graphic": graphic,
                "placeholder_or_logo": placeholder,
                "checked": checked,
                "reason": reason,
                "model": res.model if res else (self.s.image_check_model if self.s.image_check else ""),
                "tokens_in": res.tokens_in if res else 0,
                "tokens_out": res.tokens_out if res else 0,
                "cost_usd": round(res.cost_usd if res else cost_usd, 6),
            }
        )
        return answer

    async def check(self, task: str, img: Processed, url: str = "") -> tuple[bool, bool, bool]:
        """(graphic, placeholder_or_logo, checked). Fail safe: no answer means graphic. `url` is the
        image's own address, kept with the verdict."""
        if not self.s.image_check:
            return self._verdict(task, img, url, (not self.s.images_trust_unchecked, False, False), "check off")
        if not self.budget_ok():
            if not self._budget_logged:
                logger.warning("images: daily usage ceiling reached; images from here on are unchecked (graphic)")
                self._budget_logged = True
            self.stats["unchecked (budget)"] += 1
            return self._verdict(task, img, url, (True, False, False), "daily usage ceiling reached")
        assert self._check_sem is not None
        try:
            async with self._check_sem:  # the timeout starts once the call does, not while it queues
                res = await asyncio.wait_for(
                    self.llm.structured(
                        task=task,
                        system=self._system,
                        user=CHECK_USER,
                        schema=ImageCheckOut,
                        model=self.s.image_check_model,
                        max_budget_usd=self.s.budget_image_check_usd,
                        images=[ImageBlock("image/webp", img.smallest.data)],
                        thinking=False,  # a yes/no look: no reasoning tokens
                    ),
                    timeout=CHECK_TIMEOUT_S,
                )
        except TimeoutError:
            self.stats["check failed"] += 1
            logger.warning("%s: vision check gave no answer in %.0f s, image kept as graphic", task, CHECK_TIMEOUT_S)
            return self._verdict(task, img, url, (True, False, False), f"no answer in {CHECK_TIMEOUT_S:.0f} s")
        except LLMError as e:
            self.account_failure(e)
            self.stats["check failed"] += 1
            logger.warning("%s: vision check failed, image kept as graphic: %s", task, e)
            return self._verdict(task, img, url, (True, False, False), f"failed: {str(e)[:300]}", cost_usd=e.cost_usd)
        except Exception as e:  # noqa: BLE001 - any other failure is a failed check too: fail safe
            self.stats["check failed"] += 1
            logger.warning("%s: vision check failed, image kept as graphic: %s: %s", task, type(e).__name__, e)
            return self._verdict(task, img, url, (True, False, False), f"failed: {type(e).__name__}: {str(e)[:250]}")
        self.account(res, task)
        out = res.output
        return self._verdict(task, img, url, (bool(out.graphic), bool(out.placeholder_or_logo), True), "checked", res)

    # ---- one story -----------------------------------------------------------------------------
    async def pick(self, group: str, story: StoryIn, items: dict[int, ItemRef], posts: dict[int, PostRef]):
        task = f"image:{group}:{story.order}"
        assert self._sem is not None
        downloads = pages = checks = 0
        tried: set[str] = set()
        for owner in self.owners(story, items, posts):
            if isinstance(owner, PostRef):
                # X serves post media on the direct route (the one the collector reads X through)
                photo = owner.photo_url
                queue = [Candidate(photo, owner.url, "direct", owner.photo_alt, post=owner)] if photo else []
            else:
                queue = list(self._known(owner))
            page_read = False
            while True:
                if not queue:
                    if isinstance(owner, PostRef) or page_read or pages >= MAX_PAGES_PER_STORY:
                        break
                    page_read = True
                    if owner.page_fetched or owner.kind == "youtube":
                        break
                    pages += 1
                    async with self._sem:
                        if self._late(task):  # checked once it is this story's turn, not while queued
                            return None
                        queue = [c for c in await asyncio.to_thread(self._from_page, owner) if c.url not in tried]
                    if queue:
                        self.stats["og:image"] += 1
                    continue
                cand = queue.pop(0)
                if cand.url in tried:
                    continue
                tried.add(cand.url)
                if downloads >= MAX_DOWNLOADS_PER_STORY or checks >= MAX_CHECKS_PER_STORY:
                    return None
                downloads += 1
                try:
                    async with self._sem:
                        if self._late(task):
                            return None
                        img = await asyncio.to_thread(self._fetch_and_process, cand)
                except ImageRejected as e:
                    self.stats["rejected"] += 1
                    logger.info("%s: %s rejected: %s", task, cand.url[:120], e)
                    continue
                checks += 1
                graphic, placeholder, checked = await self.check(task, img, cand.url)
                if placeholder:
                    self.stats["placeholder or logo"] += 1
                    logger.info("%s: %s is a placeholder or logo; next candidate", task, cand.url[:120])
                    continue
                return Chosen(group, story, img, cand, graphic=graphic, checked=checked)
        return None

    async def pick_all(
        self, stories: list[tuple[str, StoryIn]], items: dict[int, ItemRef], posts: dict[int, PostRef]
    ) -> list[Chosen]:
        """An image for as many stories as possible, in edition order. A story whose image failed in
        any way has none; nothing raises from here except an interrupt."""
        self._sem = asyncio.Semaphore(DOWNLOADS_AT_ONCE)
        self._check_sem = asyncio.Semaphore(CHECKS_AT_ONCE)
        self._deadline = time.monotonic() + self.s.image_time_limit_s

        async def one(group: str, st: StoryIn) -> Chosen | None:
            try:
                return await self.pick(group, st, items, posts)
            except Exception as e:  # noqa: BLE001 - an image never fails a story
                logger.warning("image:%s:%s: skipped after %s: %s", group, st.order, type(e).__name__, e)
                return None

        got = await asyncio.gather(*(one(g, st) for g, st in stories))
        return self._dedupe([c for c in got if c is not None])

    def _dedupe(self, chosen: list[Chosen]) -> list[Chosen]:
        """The same picture never shows twice in an edition (the first story keeps it), and a picture
        one feed gave three or more stories is its stock image: none of them keeps it."""
        per_feed = Counter((c.image.sha256, c.cand.source_id) for c in chosen if c.cand.item)
        used: set[str] = set()
        out = []
        for c in chosen:
            if c.cand.item and per_feed[(c.image.sha256, c.cand.source_id)] >= REUSE_THRESHOLD:
                self.stats["stock picture"] += 1
                logger.info(
                    "image:%s:%s: same picture as %d other stories of its feed; dropped",
                    c.group,
                    c.story.order,
                    per_feed[(c.image.sha256, c.cand.source_id)] - 1,
                )
                continue
            if c.image.sha256 in used:
                self.stats["repeat"] += 1
                logger.info("image:%s:%s: picture already on another story; dropped", c.group, c.story.order)
                continue
            used.add(c.image.sha256)
            out.append(c)
        return out

    # ---- delivery ------------------------------------------------------------------------------
    def deliver(self, chosen: list[Chosen], *, api: WorkerApi | None, out_dir: Path | None) -> list[dict[str, Any]]:
        """Upload each image and set its story's image_id (a live run), or write the variants to
        `out_dir` (a dry run, which uploads nothing). A failed upload leaves that story without one."""
        meta: list[dict[str, Any]] = []
        for c in chosen:
            if api is not None:
                try:
                    res = api.post_image(c.to_api())
                except Exception as e:  # noqa: BLE001 - ApiError (400/413) or the app is unreachable
                    self.stats["upload failed"] += 1
                    logger.warning("image:%s:%s: upload failed: %s", c.group, c.story.order, e)
                    continue
                c.image_id = c.story.image_id = res.image_id
            elif out_dir is not None:
                try:
                    out_dir.mkdir(parents=True, exist_ok=True)
                    for v in c.image.variants:
                        path = out_dir / f"{c.image.sha256}-{v.w}.webp"
                        path.write_bytes(v.data)
                        c.files.append(str(path))
                except OSError as e:
                    logger.warning("image:%s:%s: could not write the files: %s", c.group, c.story.order, e)
            meta.append(c.meta())
            logger.info(
                "image:%s:%s: %s %dx%d%s from %s",
                c.group,
                c.story.order,
                "graphic" if c.graphic else "safe",
                c.image.width,
                c.image.height,
                "" if c.checked else " (unchecked)",
                c.cand.url[:120],
            )
        self.stats["shown"] += len(meta)
        return meta
