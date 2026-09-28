import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { Link } from "@/i18n/navigation";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { getSitePrefs } from "@/lib/queries";
import { getEntityBySlug, MAX_PAGE, relatedEntities, relatedTopics, scopedStories, weeklyCounts } from "@/lib/search";
import { formatDate, formatNumber, isLocale, langAttrs, localDigits, type Locale } from "@/lib/urdu";
import { dateAt } from "@/lib/view";
import { EntityChips, entityName } from "@/components/entity-chips";
import { TopicChips } from "@/components/topic-chips";
import { WeeklyChart, weeklySummary } from "../../topic/_components/weekly-chart";
import { Pager, StoryHits } from "../../topic/_components/story-hits";

export const dynamic = "force-dynamic";
const WEEKS = 12;
const KINDS = ["person", "org", "place", "event", "other"] as const;
type Props = { params: Promise<{ locale: string; slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
const pageParam = z.coerce.number().int().min(1).max(MAX_PAGE).catch(1);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  // Behind the wall like the page: no name for a slug unless someone is signed in.
  if (!isLocale(locale) || !(await getCurrentUser())) return {};
  const e = await getEntityBySlug(slug);
  return e ? { title: entityName(e, locale).text } : {};
}

/** A person, organisation, place or event: how often published stories name it, with what, and where. */
export default async function EntityPage({ params, searchParams }: Props) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  const raw = (await searchParams).page;
  const page = pageParam.parse(Array.isArray(raw) ? raw[0] : raw);
  await requireUser({ locale: l, next: `/${l}/entity/${encodeURIComponent(slug)}${page > 1 ? `?page=${page}` : ""}` });
  // Only entities a published story names: a name from a draft or a held edition is not shown.
  const entity = await getEntityBySlug(slug);
  if (!entity) notFound();
  const scope = { entityId: entity.id };
  const [t, tt, prefs, list, weeks, entities, topics] = await Promise.all([
    getTranslations({ locale: l, namespace: "entities" }), getTranslations({ locale: l, namespace: "topics" }), getSitePrefs(),
    scopedStories(scope, page, l), weeklyCounts(scope, WEEKS), relatedEntities(scope), relatedTopics(scope),
  ]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  const num = (s: string) => localDigits(s, l, digits);
  const day = (d: Date) => formatDate(d, l, { dateStyle: "medium" }, digits);
  const name = entityName(entity, l);
  // The other script's spelling under the heading, so a reader can match it to what they have read elsewhere.
  const other = name.lang === "ur" ? { text: entity.nameEn, lang: "en" as Locale } : entity.nameUr ? { text: entity.nameUr, lang: "ur" as Locale } : null;
  const kind = (KINDS as readonly string[]).includes(entity.kind) ? t(`kinds.${entity.kind as (typeof KINDS)[number]}`) : entity.kind;
  const { total, peak } = weeklySummary(weeks);
  const summary = [tt("chartSummary", { total, weeks: WEEKS }), peak ? tt("chartPeak", { week: formatDate(dateAt(peak.week), l, { day: "numeric", month: "long" }, digits), count: formatNumber(peak.count, l, digits) }) : ""].join(" ").trim();
  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <p className="ui meta pt-4">{kind}</p>
      <h1 className={`display rule-strong mt-3 pt-4 text-[length:var(--step-3)] ${name.lang === "en" && l === "ur" ? "latin" : ""}`} {...langAttrs(name.lang, l)}>{name.text}</h1>
      {other && <p className={`mt-1 text-[length:var(--step-1)] text-ink-2 ${other.lang === "en" ? "latin" : ""}`} {...langAttrs(other.lang, l)}>{other.text}</p>}
      <p className="meta ui mt-3">{num(t("mentions", { count: entity.mentions }))}</p>
      {entity.first && entity.last && <p className="meta ui mt-1">{t("span", { first: day(entity.first), last: day(entity.last) })}</p>}
      {entity.aliases.length > 0 && (
        <p className="meta ui mt-1">{t("alsoWritten")}: <span className="latin" lang="en" dir="ltr">{entity.aliases.join(", ")}</span></p>
      )}
      <p className="ui mt-3">
        <Link href={`/search?entity=${entity.slug}`} prefetch={false}>
          {t.rich("searchFor", { entity: name.text, name: (c) => <span className={name.lang === "en" ? "latin" : undefined} {...langAttrs(name.lang, l)}>{c}</span> })}
        </Link>
      </p>

      <section className="mt-6" aria-labelledby="per-week">
        <h2 id="per-week" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("overTime")}</h2>
        <WeeklyChart id="entity-weeks" weeks={weeks} locale={l} digits={digits} labels={{ title: `${name.text}: ${t("overTime")}`, summary: num(summary), showTable: tt("showTable"), week: tt("week"), count: t("stories") }} />
      </section>
      {(entities.length > 0 || topics.length > 0) && (
        <section className="mt-8 grid gap-6 sm:grid-cols-2" aria-label={t("related")}>
          {entities.length > 0 && (
            <div>
              <h2 className="ui text-[length:var(--step-0)] font-semibold">{t("related")}</h2>
              <div className="mt-2"><EntityChips entities={entities.map((e) => ({ ...e, salience: null }))} locale={l} label={t("related")} /></div>
            </div>
          )}
          {topics.length > 0 && (
            <div>
              <h2 className="ui text-[length:var(--step-0)] font-semibold">{t("topics")}</h2>
              <div className="mt-2"><TopicChips topics={topics.map((x) => x.topic)} locale={l} label={t("topics")} /></div>
            </div>
          )}
        </section>
      )}
      <section className="mt-8" aria-labelledby="stories">
        <h2 id="stories" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("stories")}</h2>
        <StoryHits hits={list.hits} locale={l} digits={digits} />
        <Pager page={page} total={list.total} href={(n) => `/entity/${entity.slug}${n > 1 ? `?page=${n}` : ""}`} locale={l} digits={digits} />
      </section>
    </div>
  );
}
