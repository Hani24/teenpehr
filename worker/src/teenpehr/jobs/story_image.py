"""`story_image` (decision D12): the lead image of the page a manual story links to, chosen, fetched,
cleaned and checked exactly as an edition's story images are (decision D6, images/): the item's known
image first, else the page's og:image / twitter:image / schema.org image (robots.txt and Crawl-delay
honoured), downloaded through the Fetcher on the source's route, re-encoded to stripped WebP, then the
vision check (a failed or skipped check makes it graphic, never safe). It is uploaded with
POST /api/worker/images as the item's image, and its id is the job's result; no usable image is a normal
result too (`image_id: null` with the reason)."""

from __future__ import annotations

import asyncio
from urllib.parse import urlsplit

from .. import log
from ..api import ApiError
from ..fetch.article import ArticleFetcher
from ..images import ImagePicker, usable_image_url
from ..images.picker import ItemRef
from ..models import Job, JobContext, SourceRef, StoryImageResult, StoryIn
from .base import Done, Failed, ItemCtx, JobEnv, Outcome, StoryCtx

logger = log.get("jobs.image")


def _none(note: str) -> Done:
    return Done(StoryImageResult(image_id=None, note=note[:1000]), summary=f"no image: {note}")


async def handle_image(job: Job, ctx: JobContext, env: JobEnv) -> Outcome:
    s = env.settings
    if not ctx.story or not ctx.item:
        return Failed("the job's context has no story or item", retry=False)
    story = StoryCtx.model_validate(ctx.story)
    item = ItemCtx.model_validate(ctx.item)
    if not s.images:
        return _none("images are turned off on the worker (IMAGES=0)")
    if story.live:
        return _none("the story went live before an image was found")
    if story.image_id is not None:
        return _none("the story already has an image (an editor's choice stays)")

    usage = env.usage
    picker = ImagePicker(
        s,
        env.fetcher,
        ArticleFetcher(env.fetcher),
        env.llm,
        account=lambda res, task: usage.add(res),
        account_failure=usage.add_failure,
        budget_ok=env.budget_ok,
    )
    host = (urlsplit(item.url).hostname or "").removeprefix("www.")
    ref = ItemRef(
        db_id=item.id,
        url=item.url,
        source_id=item.source.id,
        credit=(item.outlet or host)[:120],
        route=item.source.route,
        kind=item.source.kind,
        image_urls=[item.image_url] if item.image_url and usable_image_url(item.image_url) else [],
    )
    st = StoryIn(
        order=0,
        title_en=story.title_en or story.title_ur,
        summary_en=story.summary_en or story.summary_ur,
        sources=[SourceRef(item_id=item.id, is_primary=True)],
    )
    chosen = await picker.pick_all([(story.group.slug or "desk", st)], {item.id: ref}, {})
    if not chosen:
        why = ", ".join(f"{k} {v}" for k, v in picker.stats.items()) if picker.stats else ""
        return _none("no usable image on the linked page" + (f" ({why})" if why else ""))
    c = chosen[0]
    try:
        out = await asyncio.to_thread(env.api.post_image, c.to_api())
    except ApiError as e:
        if e.status >= 500:
            return Failed(f"image upload failed: {e.status} {e.message}", retry=True)
        return _none(f"the site refused the image ({e.status}: {e.message[:200]})")
    kind = "graphic, shown blurred" if c.graphic else "checked" if c.checked else "unchecked"
    note = f"{kind} image {c.image.width}x{c.image.height} from {c.cand.url[:300]}"
    logger.info("job %d: story %d image %d: %s", job.id, story.id, out.image_id, note)
    return Done(StoryImageResult(image_id=out.image_id, note=note[:1000]), summary=note)
