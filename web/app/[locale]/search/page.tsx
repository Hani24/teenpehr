import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/lib/auth";
import { getSitePrefs } from "@/lib/queries";
import { getEntityBySlug, getSearchGroups, logSearch, parseSearchParams, searchStories, topicCounts, type SearchParams, type SearchResult } from "@/lib/search";
import { TOPICS, topicLabel } from "@/lib/taxonomy";
import { formatDate, isLocale, langAttrs, localDigits, type Locale } from "@/lib/urdu";
import { dateAt } from "@/lib/view";
import { SearchBox } from "@/components/search-box";
import { ChoiceGroup } from "@/components/choice-group";
import { entityName } from "@/components/entity-chips";
import { Pager, StoryHits } from "../topic/_components/story-hits";

// Per reader (behind the login) and every search is logged, so never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "search" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

const FILTERS = ["group", "topic", "entity", "from", "to"] as const;

/** /{locale}/search with these params (empty ones left out); page 1 unless given. */
function searchHref(p: Partial<SearchParams>, page = 1): string {
  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  for (const k of FILTERS) if (p[k]) qs.set(k, p[k]!);
  if (page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return `/search${s ? `?${s}` : ""}`;
}

export default async function SearchPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  const raw = await searchParams;
  const { params: p, invalid } = parseSearchParams(raw);
  const user = await requireUser({ locale: l, next: `/${l}${searchHref(p, p.page)}` });
  const [t, tt, prefs, groups] = await Promise.all([
    getTranslations({ locale: l, namespace: "search" }), getTranslations({ locale: l, namespace: "topics" }), getSitePrefs(), getSearchGroups(),
  ]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  if (p.group && !groups.some((g) => g.slug === p.group)) { invalid.push("group"); p.group = undefined; }
  const entity = p.entity ? await getEntityBySlug(p.entity) : null;
  if (p.entity && !entity) { invalid.push("entity"); p.entity = undefined; }
  const filtered = FILTERS.some((k) => p[k]);
  const active = !!p.q || filtered;

  let result: SearchResult | null = null;
  let failed = false;
  if (active) {
    try {
      result = await searchStories(p, l);
    } catch (e) {
      console.error("search failed:", (e as Error).message);
      failed = true;
    }
    // Page 1 of a query is the search; later pages are the same search read further. An editor
    // opening a logged query from the admin's Insights (?via=insights) is not a reader's search.
    if (result && p.page === 1 && raw.via !== "insights") {
      const filters = Object.fromEntries(FILTERS.filter((k) => p[k]).map((k) => [k, p[k]]));
      await logSearch({ userId: user.id, q: p.q, locale: l, filters, results: result.total });
    }
  }
  const counts = active ? null : await topicCounts();
  const num = (s: string) => localDigits(s, l, digits);
  const groupName = (slug: string) => { const g = groups.find((x) => x.slug === slug); return g ? (l === "ur" ? g.nameUr : g.nameEn) : slug; };
  // `label` is the plain text (for the remove link's name); `content` marks up a name in the other script.
  const chips: Array<{ key: (typeof FILTERS)[number]; label: string; content?: React.ReactNode }> = [];
  if (p.group) chips.push({ key: "group", label: `${t("group")}: ${groupName(p.group)}` });
  if (p.topic) chips.push({ key: "topic", label: `${t("topic")}: ${topicLabel(p.topic, l)}` });
  if (entity) {
    const n = entityName(entity, l);
    const name = (c: React.ReactNode) => <span className={n.lang === "en" ? "latin" : undefined} {...langAttrs(n.lang, l)}>{c}</span>;
    chips.push({ key: "entity", label: t.markup("entityFilter", { entity: n.text, name: (c) => c }), content: t.rich("entityFilter", { entity: n.text, name }) });
  }
  const day = (d: string) => formatDate(dateAt(d), l, { dateStyle: "medium" }, digits);
  if (p.from) chips.push({ key: "from", label: `${t("from")}: ${day(p.from)}` });
  if (p.to) chips.push({ key: "to", label: `${t("to")}: ${day(p.to)}` });
  const field = "rounded-[var(--radius)] border border-rule bg-surface px-3 py-1.5 text-ink";

  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <h1 className="display rule-strong mt-4 pt-4 text-[length:var(--step-3)]">{t("title")}</h1>
      <p className="meta mt-2">{t("intro")}</p>
      <div className="mt-4">
        <SearchBox locale={l} q={p.q}>
          <details className="mt-3" open={filtered || undefined}>
            <summary className="cursor-pointer text-ink-2">{t("narrow")}</summary>
            {/* Sections and topics are chip radio groups, not pull-down menus (D7, components/choice-group.tsx). */}
            <div className="mt-3 grid gap-4">
              <ChoiceGroup name="group" legend={t("group")} value={p.group} pageLocale={l}
                choices={[{ value: "", label: t("anyGroup") }, ...groups.map((g) => ({ value: g.slug, label: l === "ur" ? g.nameUr : g.nameEn }))]} />
              <ChoiceGroup name="topic" legend={t("topic")} value={p.topic} pageLocale={l}
                choices={[{ value: "", label: t("anyTopic") }, ...TOPICS.map((x) => ({ value: x, label: topicLabel(x, l) }))]} />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1"><span className="meta">{t("from")}</span><input type="date" name="from" defaultValue={p.from ?? ""} className={field} /></label>
                <label className="grid gap-1"><span className="meta">{t("to")}</span><input type="date" name="to" defaultValue={p.to ?? ""} className={field} /></label>
              </div>
            </div>
            {p.entity && <input type="hidden" name="entity" value={p.entity} />}
            <button type="submit" className="chip mt-3 font-semibold text-ink">{t("apply")}</button>
          </details>
        </SearchBox>
      </div>

      {chips.length > 0 && (
        <ul className="ui mt-4 flex flex-wrap items-center gap-2" aria-label={t("narrow")}>
          {chips.map((c) => (
            <li key={c.key}>
              <Link href={searchHref({ ...p, [c.key]: undefined })} prefetch={false} className="chip" aria-label={t("remove", { name: c.label })}>
                <span>{c.content ?? c.label}</span> <span aria-hidden="true">×</span>
              </Link>
            </li>
          ))}
          {chips.length > 1 && <li><Link href={searchHref({ q: p.q })} prefetch={false} className="meta">{t("clear")}</Link></li>}
        </ul>
      )}

      {invalid.length > 0 && <p role="status" className="card mt-4 p-3 text-ink-2">{t("invalid")}</p>}
      {failed && <p role="alert" className="card mt-6 p-4 text-warn">{t("error")}</p>}

      {result && (
        <section className="mt-6" aria-labelledby="results">
          <h2 id="results" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold" aria-live="polite">
            {num(p.q ? t("resultsFor", { count: result.total, q: p.q }) : t("results", { count: result.total }))}
          </h2>
          {result.mode === "fuzzy" && result.total > 0 && <p className="meta mt-2">{t("fuzzy")}</p>}
          {result.total === 0 ? (
            <div className="mt-4">
              <p>{t("none")}</p>
              <p className="meta mt-2 measure">{t("tips")}</p>
            </div>
          ) : (
            <>
              <StoryHits hits={result.hits} locale={l} digits={digits} />
              <Pager page={p.page} total={result.total} href={(n) => searchHref(p, n)} locale={l} digits={digits} />
            </>
          )}
        </section>
      )}

      {!active && counts && (
        <section className="mt-8" aria-labelledby="browse">
          <h2 id="browse" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("browseTopics")}</h2>
          <ul className="ui mt-3 grid gap-2 sm:grid-cols-2">
            {TOPICS.map((x) => (
              <li key={x}>
                <Link href={`/topic/${x}`} prefetch={false} className="flex items-baseline justify-between gap-3 rounded-[var(--radius)] border border-rule bg-surface px-3 py-2 no-underline hover:border-rule-strong">
                  <span className="text-ink">{topicLabel(x, l)}</span>
                  <span className="meta">{num(tt("count", { count: counts.get(x) ?? 0 }))}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
