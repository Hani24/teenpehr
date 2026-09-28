import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { StoryFull } from "@/lib/queries";
import { formatNumber, langAttrs, picked, type Locale } from "@/lib/urdu";
import { outletsOf } from "@/lib/view";
import { getGlossaryMap, getSitePrefs } from "@/lib/queries";
import { CoverageBadge } from "./coverage-badge";
import { SourceChips } from "./source-chips";
import { RelativeTime } from "./relative-time";
import { SaveButton } from "./save-button";
import { StoryChips } from "./entity-chips";
import { StoryImage } from "./story-image";
import { storySavedState } from "@/lib/saved";

/**
 * A story on an edition or section page. Its publisher image (components/story-image.tsx): must-read
 * cards (and the edition's lead) show it large above the headline, other cards as a small picture at the
 * inline end; in Wazeh it moves below the headline (globals.css), so it never pushes a headline down.
 */
export async function StoryCard({ story, locale, lead = false, hiddenIn }: { story: StoryFull; locale: Locale; lead?: boolean; hiddenIn?: string[] }) {
  const t = await getTranslations();
  const prefs = await getSitePrefs();
  const digits = locale === "ur" ? prefs.digitsUr : undefined;
  const outlets = outletsOf(story);
  const labels = locale === "ur" ? await getGlossaryMap() : undefined;
  const title = picked(story, "title", locale);
  const summary = picked(story, "summary", locale);
  const why = picked(story, "why", locale);
  const newest = story.sources.map((s) => s.item.publishedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  // The reader's saved state (one query per request for every card); null when signed out: no button.
  const saved = await storySavedState(story.id);
  return (
    <article className={`story-card rule-top py-5 ${lead ? "md:py-7" : ""}`} aria-labelledby={`s-${story.id}`} data-hidden-in={hiddenIn?.length ? hiddenIn.join(" ") : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        {story.tag === "must-read" && <span className="pill pill-accent">{t("tags.must-read")}</span>}
        {story.thread && <span className="pill pill-soft">{t("story.thread")}</span>}
        {story.qaStatus === "flagged" && <span className="pill pill-soft">{t("qa.flagged")}</span>}
      </div>
      {/* The edition's lead image loads at once; the rest as they come into view. */}
      <StoryImage story={story} locale={locale} variant={lead || story.tag === "must-read" ? "lead" : "thumb"} priority={lead} />
      <h3 id={`s-${story.id}`} className={`headline mt-2 ${lead ? "text-[length:var(--step-3)]" : "text-[length:var(--step-2)]"}`} {...langAttrs(title.lang, locale)}>
        <Link href={`/story/${story.id}`} className="no-underline hover:underline">{title.text}</Link>
      </h3>
      <p className={`prose mt-2 ${lead ? "" : "clamp-3"} text-ink`} {...langAttrs(summary.lang, locale)}>{summary.text}</p>
      {why.text && <p className="mt-2 text-ink-2"><span className="font-semibold text-ink">{t("story.whyItMatters")}:</span> <span {...langAttrs(why.lang, locale)}>{why.text}</span></p>}
      <StoryChips story={story} locale={locale} maxTopics={2} maxEntities={3} />
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <SourceChips outlets={outlets} labels={labels} locale={locale} digits={digits} />
        <CoverageBadge coverage={story.coverage} outletCount={outlets.length} />
        {newest && <RelativeTime iso={newest.toISOString()} locale={locale} digits={digits} className="meta" />}
        {story.posts.length > 0 && <span className="meta">{t("story.posts")} · {formatNumber(story.posts.length, locale, digits)}</span>}
        {saved !== null && <SaveButton kind="story" id={story.id} saved={saved} labelledBy={`s-${story.id}`} className="ms-auto" />}
      </div>
    </article>
  );
}
