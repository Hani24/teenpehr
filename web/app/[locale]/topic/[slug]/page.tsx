import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/lib/auth";
import { getSitePrefs } from "@/lib/queries";
import { MAX_PAGE, relatedEntities, relatedTopics, scopedStories, weeklyCounts } from "@/lib/search";
import { isTopic, topicLabel } from "@/lib/taxonomy";
import { formatDate, formatNumber, isLocale, localDigits, type Locale } from "@/lib/urdu";
import { dateAt } from "@/lib/view";
import { EntityChips } from "@/components/entity-chips";
import { TopicChips } from "@/components/topic-chips";
import { WeeklyChart, weeklySummary } from "../_components/weekly-chart";
import { Pager, StoryHits } from "../_components/story-hits";

export const dynamic = "force-dynamic";
const WEEKS = 12;
type Props = { params: Promise<{ locale: string; slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
const pageParam = z.coerce.number().int().min(1).max(MAX_PAGE).catch(1);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale) || !isTopic(slug)) return {};
  return { title: topicLabel(slug, locale) };
}

/** One topic: its stories per week, the names and topics that come with it, and every story, newest first. */
export default async function TopicPage({ params, searchParams }: Props) {
  const { locale, slug } = await params;
  if (!isLocale(locale) || !isTopic(slug)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  const raw = (await searchParams).page;
  const page = pageParam.parse(Array.isArray(raw) ? raw[0] : raw);
  await requireUser({ locale: l, next: `/${l}/topic/${slug}${page > 1 ? `?page=${page}` : ""}` });
  const scope = { topic: slug };
  const [t, prefs, list, weeks, entities, topics] = await Promise.all([
    getTranslations({ locale: l, namespace: "topics" }), getSitePrefs(), scopedStories(scope, page, l), weeklyCounts(scope, WEEKS), relatedEntities(scope), relatedTopics(scope),
  ]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  const num = (s: string) => localDigits(s, l, digits);
  const { total, peak } = weeklySummary(weeks);
  const summary = [t("chartSummary", { total, weeks: WEEKS }), peak ? t("chartPeak", { week: formatDate(dateAt(peak.week), l, { day: "numeric", month: "long" }, digits), count: formatNumber(peak.count, l, digits) }) : ""].join(" ").trim();
  const label = topicLabel(slug, l);
  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <nav aria-label="Breadcrumb" className="ui meta pt-4"><Link href="/topic" prefetch={false}>{t("title")}</Link></nav>
      <h1 className="display rule-strong mt-3 pt-4 text-[length:var(--step-3)]">{label}</h1>
      <p className="meta ui mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <span>{num(t("count", { count: list.total }))}</span>
        <Link href={`/search?topic=${slug}`} prefetch={false}>{t("searchWithin")}</Link>
      </p>

      {list.total === 0 ? <p className="ui mt-8 text-ink-2">{t("none")}</p> : (
        <>
          <section className="mt-6" aria-labelledby="per-week">
            <h2 id="per-week" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("overTime")}</h2>
            <WeeklyChart id="topic-weeks" weeks={weeks} locale={l} digits={digits} labels={{ title: `${label}: ${t("overTime")}`, summary: num(summary), showTable: t("showTable"), week: t("week"), count: t("stories") }} />
          </section>
          {(entities.length > 0 || topics.length > 0) && (
            <section className="mt-8 grid gap-6 sm:grid-cols-2" aria-label={t("related")}>
              {entities.length > 0 && (
                <div>
                  <h2 className="ui text-[length:var(--step-0)] font-semibold">{t("people")}</h2>
                  <div className="mt-2"><EntityChips entities={entities.map((e) => ({ ...e, salience: null }))} locale={l} label={t("people")} /></div>
                </div>
              )}
              {topics.length > 0 && (
                <div>
                  <h2 className="ui text-[length:var(--step-0)] font-semibold">{t("related")}</h2>
                  <div className="mt-2"><TopicChips topics={topics.map((x) => x.topic)} locale={l} label={t("related")} /></div>
                </div>
              )}
            </section>
          )}
          <section className="mt-8" aria-labelledby="stories">
            <h2 id="stories" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("timeline")}</h2>
            <StoryHits hits={list.hits} locale={l} digits={digits} />
            <Pager page={page} total={list.total} href={(n) => `/topic/${slug}${n > 1 ? `?page=${n}` : ""}`} locale={l} digits={digits} />
          </section>
        </>
      )}
    </div>
  );
}
