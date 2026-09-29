"""`fill_language` (decision D12): an editor wrote a manual story in one language; write the other side
from the editor's text only.

The site writes only the payload's language and only into empty fields (never over an editor's text),
and refuses a story that is live. Here: a live or non-manual story is refused before any Claude call,
the editor's source side must have a title and a summary, and a model text that adds a figure the editor
did not write is refused (after one retry), so an editor writes that side instead. The story stays
unready (off the desk, out of a publishing edition) until its missing side exists."""

from __future__ import annotations

from pydantic import ValidationError

from .. import log
from ..models import FillFields, FillLanguageResult, Job, JobContext
from ..translate import ArticleTranslator, CostCeiling, FillRefused, TranslationFailed
from .base import BudgetReached, Done, Failed, JobEnv, Outcome, StoryCtx
from .budget import seconds_to_midnight

logger = log.get("jobs.fill")


async def handle_fill(job: Job, ctx: JobContext, env: JobEnv) -> Outcome:
    s = env.settings
    lang = job.payload.get("lang")
    if lang not in ("en", "ur"):
        return Failed(f"unknown language {lang!r} in the payload", retry=False)
    if not ctx.story:
        return Failed("the job's context has no story", retry=False)
    story = StoryCtx.model_validate(ctx.story)
    if story.origin != "manual":
        return Failed("not a manual story: only an editor's story is filled in", retry=False)
    if story.live:
        return Failed("the story is live: a live story is never edited", retry=False)
    src_lang = "ur" if lang == "en" else "en"
    source, target = story.side(src_lang), story.side(lang)
    needed = [f for f in ("title", "summary", "why", "contested") if source[f] and not target[f]]
    if target["title"] and target["summary"] and not needed:
        # Every field the editor wrote has its other side already: nothing to write, nothing spent.
        fields = FillFields(**{k: v for k, v in target.items() if v})
        return Done(FillLanguageResult(fields={lang: fields}), summary="nothing to fill")
    if not source["title"] or not source["summary"]:
        other = "English" if src_lang == "en" else "Urdu"
        return Failed(
            f"nothing to write from: the editor's {other} title and summary are both needed (write the other side "
            "by hand)",
            retry=False,
        )
    if not env.budget_ok():
        raise BudgetReached("the daily usage ceiling was reached", retry_after_s=seconds_to_midnight(s))
    usage = env.usage
    translator = ArticleTranslator(
        s,
        env.llm,
        account=usage.add,
        account_failure=usage.add_failure,
        budget_ok=env.budget_ok,
        over_budget=lambda: BudgetReached("the daily usage ceiling was reached", retry_after_s=seconds_to_midnight(s)),
        spent=lambda: usage.cost_usd,
    )
    try:
        out = await translator.fill(
            key=str(story.id),
            target=lang,  # type: ignore[arg-type]
            source_fields=source,
            target_fields=target,
            group=story.group.name_en or story.group.slug,
            glossary=ctx.glossary,
        )
    except FillRefused as e:
        return Failed(f"the filled-in text was refused: {e}; an editor should write this side", retry=False)
    except CostCeiling as e:
        return Failed(f"{e}; an editor should write this side", retry=False)
    except TranslationFailed as e:
        return Failed(str(e), retry=True)
    try:
        fields = FillFields(**out.model_dump())
    except ValidationError as e:
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(x) for x in first.get("loc", ()))
        why = f"the filled-in {where or 'text'} does not fit ({first.get('msg', e)}); write it by hand"
        return Failed(why, retry=False)
    result = FillLanguageResult(fields={lang: fields}, **usage.fields(s.fill_model(lang)))
    return Done(result, summary=f"{lang} side written ({', '.join(needed) or 'title, summary'})")
