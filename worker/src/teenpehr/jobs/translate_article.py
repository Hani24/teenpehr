"""`translate_article` (decision D9): a reader asked for a cited article in full, in Urdu.

The item's page is fetched on its source's route by FullTextFetcher (robots.txt, Crawl-delay, 429
cooldowns, one request per host, no paywall ever bypassed); what cannot be had legitimately is a
`blocked` result with its reason, which the reader page turns into "could not get the full text, here is
the link". Otherwise ArticleTranslator translates the whole text and checks it, and the translation,
its check note and its usage go back as the job's result. An article that reaches its own usage limit
(TRANSLATE_MAX_USD) before it is done is `too_long`, final, so it is never paid for again."""

from __future__ import annotations

import asyncio
from urllib.parse import urlsplit

from .. import log
from ..models import Job, JobContext, TranslateArticleBlockedResult, TranslateArticleDone, TranslateBlocked
from ..translate import ArticleTranslator, CostCeiling, TranslationFailed
from .base import BudgetReached, Done, Failed, ItemCtx, JobEnv, Outcome, TranslationCtx
from .budget import seconds_to_midnight
from .fulltext import TryLater, Unavailable

logger = log.get("jobs.translate")

LANG_NAMES = {
    "en": "English",
    "ar": "Arabic",
    "fa": "Persian",
    "ps": "Pashto",
    "hi": "Hindi",
    "bn": "Bengali",
    "pa": "Punjabi",
    "tr": "Turkish",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "ru": "Russian",
    "zh": "Chinese",
    "he": "Hebrew",
    "und-Latn": "a language in Latin script",
}
VIDEO_HOSTS = ("youtube.com", "youtu.be", "vimeo.com", "dailymotion.com")
SOCIAL_HOSTS = ("x.com", "twitter.com", "bsky.app", "t.me", "facebook.com", "instagram.com", "tiktok.com")
BODY_MAX = 200_000  # web/lib/contracts.ts TRANSLATION_BODY_MAX


def _on(host: str, domains: tuple[str, ...]) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def _blocked(reason, note: str, env: JobEnv) -> Done:
    blocked = TranslateBlocked(reason=reason, note=note[:1000])
    result = TranslateArticleBlockedResult(blocked=blocked, **env.usage.fields())
    return Done(result, summary=f"blocked ({reason}): {note}")


def precheck(item: ItemCtx) -> tuple[str, str] | None:
    """(reason, note) when the item can be refused without fetching anything."""
    host = (urlsplit(item.url).hostname or "").lower()
    if item.lang == "ur":
        return "not_article", "the article is already in Urdu"
    if item.source.kind == "youtube" or _on(host, VIDEO_HOSTS):
        return "not_article", "the link is a video, not an article"
    if _on(host, SOCIAL_HOSTS):
        return "not_article", "the link is a social media post, not an article"
    if host == "news.google.com":
        return "unreachable", "a Google News link that was never resolved to the publisher's own page"
    return None


async def handle_translate(job: Job, ctx: JobContext, env: JobEnv) -> Outcome:
    s = env.settings
    if job.payload.get("lang", "ur") != "ur":
        return Failed(f"unsupported language {job.payload.get('lang')!r}: only Urdu translations exist", retry=False)
    if not ctx.item:
        return Failed("the job's context has no item", retry=False)
    item = ItemCtx.model_validate(ctx.item)
    stored = TranslationCtx.model_validate(ctx.translation) if ctx.translation else None
    early = precheck(item)
    if early:
        return _blocked(early[0], early[1], env)

    last = job.attempts >= job.max_attempts
    try:
        full = await asyncio.to_thread(
            env.fulltext.fetch, item.url, route=item.source.route, last_attempt=last, title_hint=item.title
        )
    except Unavailable as e:
        return _blocked(e.reason, e.note, env)
    except TryLater as e:
        return Failed(f"could not fetch the article yet: {e.note}", retry=True, retry_after_s=e.retry_after_s)
    logger.info(
        "job %d: item %d (%s) fetched on %s: %d paragraphs, %d words, language %s",
        job.id,
        item.id,
        item.outlet,
        full.route,
        len(full.paragraphs),
        full.words,
        full.lang,
    )
    if stored and stored.status == "done" and stored.source_text_hash == full.text_hash:
        return Failed("the article has not changed since its stored translation: nothing to redo", retry=False)
    if not env.budget_ok():
        raise BudgetReached("the daily usage ceiling was reached", retry_after_s=seconds_to_midnight(s))

    usage = env.usage
    translator = ArticleTranslator(
        s,
        env.llm,
        account=usage.add,
        account_failure=usage.add_failure,
        budget_ok=env.budget_ok,
        over_budget=lambda: BudgetReached(
            "the daily usage ceiling was reached during the translation", retry_after_s=seconds_to_midnight(s)
        ),
        spent=lambda: usage.cost_usd,
    )
    lang = full.lang or item.lang or "en"
    try:
        tr = await translator.translate(
            key=str(item.id),
            title=full.title,
            paragraphs=full.paragraphs,
            outlet=item.outlet,
            source_lang=LANG_NAMES.get(lang, lang),
            glossary=ctx.glossary,
        )
    except CostCeiling as e:
        # Final, and said plainly to the reader: trying again would spend the same again on the same text.
        return _blocked("too_long", f"the article is too long to translate within its usage limit ({e})", env)
    except TranslationFailed as e:
        return Failed(str(e), retry=True)
    body = tr.body
    if len(body) > BODY_MAX:
        return _blocked("too_long", f"the Urdu text would be {len(body)} characters; the limit is {BODY_MAX}", env)
    title = (tr.title or full.title or item.title).strip() or body.split("\n", 1)[0][:150]
    result = TranslateArticleDone(
        title=title[:1000],
        body=body,
        source_words=full.words,
        source_text_hash=full.text_hash,
        check_ok=tr.check_ok,
        check_note=tr.check_note,
        **usage.fields(tr.model),
    )
    summary = (
        f"{full.words} words in {len(tr.paragraphs)} paragraphs, check {'passed' if tr.check_ok else 'found problems'}"
        + (f", {tr.repaired} retranslated" if tr.repaired else "")
    )
    return Done(result, summary=summary)
