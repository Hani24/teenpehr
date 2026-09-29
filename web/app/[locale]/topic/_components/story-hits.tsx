import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { MARK_END, MARK_START, PAGE_SIZE, type StoryHit } from "@/lib/search";
import { formatDate, langAttrs, localDigits, slotNames, type Locale, type UrduDigits } from "@/lib/urdu";
import { dateAt } from "@/lib/view";
import { TopicChips } from "@/components/topic-chips";
import { ManualBadge } from "@/components/manual-badge";
import { ReviewPill } from "@/components/review-badge";

/** Text from ts_headline with its matches as <mark> (bold as well as tinted, so not by colour alone). */
export function Marked({ text }: { text: string }) {
  const parts = text.split(new RegExp(`(${MARK_START}[^${MARK_END}]*${MARK_END})`, "u"));
  return (
    <>
      {parts.map((p, i) => p.startsWith(MARK_START)
        ? <mark key={i} className="rounded-sm bg-[color-mix(in_oklab,var(--accent)_20%,transparent)] px-0.5 font-semibold text-ink">{p.slice(1, -1)}</mark>
        : p.replace(new RegExp(`[${MARK_START}${MARK_END}]`, "gu"), ""))}
    </>
  );
}

/** A list of published stories: headline, where it ran, a snippet and its topics. */
export async function StoryHits({ hits, locale, digits, groupNames }: { hits: StoryHit[]; locale: Locale; digits?: UrduDigits; groupNames?: boolean }) {
  const t = await getTranslations({ locale, namespace: "topics" });
  return (
    <ol className="mt-2">
      {hits.map((h) => {
        const titleLang: Locale = locale === "ur" && h.titleUr ? "ur" : "en";
        const title = h.titleMarked ?? (titleLang === "ur" ? h.titleUr : h.titleEn);
        return (
          <li key={h.id} className="rule-top py-4">
            <h3 className="headline text-[length:var(--step-1)]" {...langAttrs(titleLang, locale)}>
              <Link href={`/story/${h.id}`} className="no-underline hover:underline"><Marked text={title} /></Link>
            </h3>
            <p className="meta ui mt-1">
              <time dateTime={h.date}>{formatDate(dateAt(h.date), locale, { dateStyle: "medium" }, digits)}</time>
              {" · "}{slotNames[h.slot][locale]}
              {groupNames !== false && <>{" · "}{locale === "ur" ? h.groupUr : h.groupEn}</>}
            </p>
            {h.origin === "manual"
              ? <p className="ui mt-2"><ManualBadge story={{ origin: h.origin, createdByName: h.createdByName, languageFilled: null }} /></p>
              : <p className="ui mt-2"><ReviewPill story={{ origin: h.origin, qaStatus: h.qaStatus, reviewedAt: h.reviewedAt }} /></p>}
            {h.snippet && <p className="prose mt-2 text-ink-2" {...langAttrs(h.snippetLang, locale)}><Marked text={h.snippet} /></p>}
            <div className="mt-2"><TopicChips topics={h.topics} locale={locale} label={t("inStory")} max={3} /></div>
          </li>
        );
      })}
    </ol>
  );
}

/** Previous / next links that keep the rest of the query. */
export async function Pager({ page, total, href, locale, digits }: { page: number; total: number; href: (page: number) => string; locale: Locale; digits?: UrduDigits }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  const t = await getTranslations({ locale, namespace: "search" });
  const shown = Math.min(pages, 50);
  return (
    <nav aria-label={t("pages")} className="ui mt-6 flex flex-wrap items-center gap-3">
      {page > 1 && <Link href={href(page - 1)} prefetch={false} rel="prev" className="chip">{t("previous")}</Link>}
      <span className="meta" aria-current="page">{localDigits(t("page", { page, pages: shown }), locale, digits)}</span>
      {page < shown && <Link href={href(page + 1)} prefetch={false} rel="next" className="chip">{t("next")}</Link>}
    </nav>
  );
}
