import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { StoryFull } from "@/lib/queries";
import { pick, relativeTime, type Locale } from "@/lib/urdu";
import { outletsOf } from "@/lib/view";
import { getGlossaryMap } from "@/lib/queries";
import { CoverageBadge } from "./coverage-badge";
import { SourceChips } from "./source-chips";

export async function StoryCard({ story, locale, lead = false, now }: { story: StoryFull; locale: Locale; lead?: boolean; now: Date }) {
  const t = await getTranslations();
  const outlets = outletsOf(story);
  const labels = locale === "ur" ? await getGlossaryMap() : undefined;
  const title = pick(story, "title", locale);
  const summary = pick(story, "summary", locale);
  const why = pick(story, "why", locale);
  const newest = story.sources.map((s) => s.item.publishedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  return (
    <article className={`rule-top py-5 ${lead ? "md:py-7" : ""}`} aria-labelledby={`s-${story.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        {story.tag === "must-read" && <span className="pill pill-accent">{t("tags.must-read")}</span>}
        {story.thread && <span className="pill pill-soft">{t("story.thread")}</span>}
        {story.qaStatus === "flagged" && <span className="pill pill-soft">{t("qa.flagged")}</span>}
      </div>
      <h3 id={`s-${story.id}`} className={`headline mt-2 ${lead ? "text-[length:var(--step-3)]" : "text-[length:var(--step-2)]"}`}>
        <Link href={`/story/${story.id}`} className="no-underline hover:underline">{title}</Link>
      </h3>
      <p className={`prose mt-2 ${lead ? "" : "clamp-3"} text-ink`}>{summary}</p>
      {why && <p className="mt-2 text-ink-2"><span className="font-semibold text-ink">{t("story.whyItMatters")}:</span> {why}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <SourceChips outlets={outlets} labels={labels} />
        <CoverageBadge coverage={story.coverage} outletCount={outlets.length} />
        {newest && <span className="meta">{relativeTime(newest, now, locale)}</span>}
        {story.posts.length > 0 && <span className="meta">{t("story.posts")} · {story.posts.length}</span>}
      </div>
    </article>
  );
}
