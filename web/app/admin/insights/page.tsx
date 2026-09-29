import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requireRole, roleAtLeast } from "@/lib/auth";
import { coverageByPerspective, itemsPerSourcePerDay, revisionStats, searchTotals, storiesPerGroupPerDay, topSearches, trendingEntities, trendingTopics, type DayMatrix, type Trend } from "@/lib/insights";
import { topicLabel } from "@/lib/taxonomy";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { FeedbackSummary } from "../feedback/summary";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Insights" };

const nf = new Intl.NumberFormat("en-GB");
const dayLabel = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

/** One bar, square at the start and rounded at its end; the number beside it carries the value. */
function Bar({ value, max, tone }: { value: number; max: number; tone: "now" | "before" }) {
  const pct = max ? Math.max(value ? 2 : 0, (value / max) * 100) : 0;
  return (
    <span className="inline-flex w-full items-center gap-2" aria-hidden="true">
      <span className="h-2.5 min-w-0 flex-1">
        <span className={`block h-full rounded-e-[4px] ${tone === "now" ? "bg-accent" : "bg-ink-3 opacity-60"}`} style={{ inlineSize: `${pct}%` }} />
      </span>
    </span>
  );
}

function TrendTable({ rows, caption, nameHeader, t, href }: { rows: Trend[]; caption: string; nameHeader: string; t: Awaited<ReturnType<typeof getTranslations<"insights">>>; href: (r: Trend) => string }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.now, r.before]));
  return (
    <Table caption={caption}>
      <thead><tr><Th>{nameHeader}</Th><Th className="w-[40%]">{t("thisWeek")} / {t("previousWeek")}</Th><Th className="text-end">{t("thisWeek")}</Th><Th className="text-end">{t("previousWeek")}</Th><Th className="text-end">{t("change")}</Th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const d = r.now - r.before;
          return (
            <tr key={r.key}>
              <Td>
                <Link href={href(r)} target="_blank" rel="noreferrer">{r.label}</Link>
                {r.kind && <span className="meta"> ({r.kind})</span>}
                {r.labelUr ? <span className="meta block" lang="ur" dir="rtl">{r.labelUr}</span> : null}
              </Td>
              <Td><Bar value={r.now} max={max} tone="now" /><span className="mt-1 block"><Bar value={r.before} max={max} tone="before" /></span></Td>
              <Td className="text-end tabular-nums">{nf.format(r.now)}</Td>
              <Td className="text-end tabular-nums text-ink-2">{nf.format(r.before)}</Td>
              <Td className={`text-end tabular-nums ${d > 0 ? "font-semibold" : "text-ink-2"}`}>{d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "0"}{d > 0 ? " ▲" : d < 0 ? " ▼" : ""}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function DayTable({ m, caption, nameHeader, total }: { m: DayMatrix; caption: string; nameHeader: string; total: string }) {
  const sums = m.days.map((d) => m.rows.reduce((n, r) => n + (r.perDay[d] ?? 0), 0));
  return (
    <Table caption={caption}>
      <thead><tr><Th>{nameHeader}</Th>{m.days.map((d) => <Th key={d} className="text-end whitespace-nowrap">{dayLabel(d)}</Th>)}<Th className="text-end">{total}</Th></tr></thead>
      <tbody>
        {m.rows.map((r) => (
          <tr key={r.key}>
            <Td className="whitespace-nowrap">{r.label}</Td>
            {m.days.map((d) => <Td key={d} className={`text-end tabular-nums ${r.perDay[d] ? "" : "text-ink-3"}`}>{r.perDay[d] ? nf.format(r.perDay[d]) : "·"}</Td>)}
            <Td className="text-end font-semibold tabular-nums">{nf.format(r.total)}</Td>
          </tr>
        ))}
        <tr><Td className="font-semibold">{total}</Td>{sums.map((s, i) => <Td key={m.days[i]} className="text-end font-semibold tabular-nums">{nf.format(s)}</Td>)}<Td className="text-end font-semibold tabular-nums">{nf.format(sums.reduce((a, b) => a + b, 0))}</Td></tr>
      </tbody>
    </Table>
  );
}

export default async function InsightsPage() {
  const user = await requireRole("editor", { locale: "en", next: "/admin/insights" });
  const t = await getTranslations({ locale: "en", namespace: "insights" });
  const [topics, names, searches, zero, totals, perGroup, perSource, revisions, coverage] = await Promise.all([
    trendingTopics(), trendingEntities(), topSearches(), topSearches({ zeroOnly: true }), searchTotals(),
    storiesPerGroupPerDay(14), itemsPerSourcePerDay(7), revisionStats(), coverageByPerspective(30),
  ]);
  const topicRows = topics.map((r) => ({ ...r, label: topicLabel(r.key, "en") }));
  const h2 = "mb-2 mt-8 text-lg font-semibold";
  return (
    <AdminShell title={t("title")}>
      <p className="meta">{t("intro")}</p>
      {roleAtLeast(user.role, "owner") && (
        <p className="mt-2"><Link href="/admin/export" className="chip">{t("exports")}</Link> <span className="meta">{t("exportsText")}</span></p>
      )}

      <p className="meta mt-6 flex flex-wrap items-center gap-4" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-e-[4px] bg-accent" />{t("thisWeek")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-e-[4px] bg-ink-3 opacity-60" />{t("previousWeek")}</span>
      </p>
      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="tt">
          <h2 id="tt" className={h2}>{t("trendingTopics")}</h2>
          {topicRows.length ? <TrendTable rows={topicRows} caption={t("trendingTopics")} nameHeader={t("topic")} t={t} href={(r) => `/en/topic/${r.key}`} /> : <Empty>{t("noTrend")}</Empty>}
        </section>
        <section aria-labelledby="te">
          <h2 id="te" className={h2}>{t("trendingEntities")}</h2>
          {names.length ? <TrendTable rows={names} caption={t("trendingEntities")} nameHeader={t("name")} t={t} href={(r) => `/en/entity/${r.key}`} /> : <Empty>{t("noTrend")}</Empty>}
        </section>
      </div>

      {/* Relevance votes and mistake reports (D8); the full view is /admin/feedback. */}
      <FeedbackSummary />

      <section aria-labelledby="se">
        <h2 id="se" className={h2}>{t("searches")}</h2>
        <p className="meta mb-2">{t("searchTotals", totals)}</p>
        <div className="grid gap-6 xl:grid-cols-2">
          {searches.length ? (
            <Table caption={t("searches")}>
              <thead><tr><Th>{t("query")}</Th><Th className="text-end">{t("times")}</Th><Th className="text-end">{t("readers")}</Th><Th className="text-end">{t("avgResults")}</Th><Th>{t("lastSearched")}</Th></tr></thead>
              <tbody>{searches.map((s) => (
                <tr key={s.q}><Td><Link href={`/en/search?q=${encodeURIComponent(s.q)}&via=insights`} target="_blank" rel="noreferrer"><bdi>{s.q}</bdi></Link></Td><Td className="text-end tabular-nums">{nf.format(s.count)}</Td><Td className="text-end tabular-nums">{nf.format(s.readers)}</Td><Td className="text-end tabular-nums">{nf.format(s.avgResults)}</Td><Td>{fmtDate(s.last)}</Td></tr>
              ))}</tbody>
            </Table>
          ) : <Empty>{t("noSearches")}</Empty>}
          <div>
            <h3 className="mb-2 font-semibold">{t("zeroSearches")}</h3>
            {zero.length ? (
              <Table caption={t("zeroSearches")}>
                <thead><tr><Th>{t("query")}</Th><Th className="text-end">{t("times")}</Th><Th className="text-end">{t("readers")}</Th><Th>{t("lastSearched")}</Th></tr></thead>
                <tbody>{zero.map((s) => (
                  <tr key={s.q}><Td><bdi>{s.q}</bdi></Td><Td className="text-end tabular-nums">{nf.format(s.count)}</Td><Td className="text-end tabular-nums">{nf.format(s.readers)}</Td><Td>{fmtDate(s.last)}</Td></tr>
                ))}</tbody>
              </Table>
            ) : <Empty>{t("noSearches")}</Empty>}
          </div>
        </div>
      </section>

      <section aria-labelledby="pg">
        <h2 id="pg" className={h2}>{t("storiesPerGroup")}</h2>
        {perGroup.rows.length ? <DayTable m={perGroup} caption={t("storiesPerGroup")} nameHeader={t("section")} total={t("total")} /> : <Empty>{t("noData")}</Empty>}
      </section>
      <section aria-labelledby="ps">
        <h2 id="ps" className={h2}>{t("itemsPerSource")}</h2>
        {perSource.rows.length ? <DayTable m={perSource} caption={t("itemsPerSource")} nameHeader={t("source")} total={t("total")} /> : <Empty>{t("noData")}</Empty>}
      </section>

      <section aria-labelledby="rv">
        <h2 id="rv" className={h2}>{t("revisions")}</h2>
        <p className="meta mb-2">{t("revisionsSummary", { week: nf.format(revisions.week), month: nf.format(revisions.month), items: revisions.items })}</p>
        {revisions.recent.length ? (
          <div className="grid gap-6 xl:grid-cols-[1fr_2fr]">
            <Table caption={`${t("revisions")}: ${t("source")}`}>
              <thead><tr><Th>{t("source")}</Th><Th className="text-end">{t("revisions")}</Th><Th className="text-end">{t("items")}</Th></tr></thead>
              <tbody>{revisions.bySource.map((s) => <tr key={s.name}><Td>{s.name}</Td><Td className="text-end tabular-nums">{nf.format(s.revisions)}</Td><Td className="text-end tabular-nums">{nf.format(s.items)}</Td></tr>)}</tbody>
            </Table>
            <Table caption={t("revisions")}>
              <thead><tr><Th>{t("source")}</Th><Th>{t("firstHeadline")}</Th><Th>{t("nowHeadline")}</Th><Th>{t("seen")}</Th></tr></thead>
              <tbody>{revisions.recent.map((r, i) => (
                <tr key={`${r.itemId}-${i}`}><Td>{r.source}</Td><Td><a href={r.url} target="_blank" rel="noopener noreferrer"><bdi>{r.first}</bdi></a></Td><Td>{r.textOnly ? <span className="text-ink-2">{t("textChanged")}</span> : <bdi>{r.now}</bdi>}</Td><Td className="whitespace-nowrap">{fmtDate(r.seenAt)}</Td></tr>
              ))}</tbody>
            </Table>
          </div>
        ) : <Empty>{t("noData")}</Empty>}
      </section>

      <section aria-labelledby="cv">
        <h2 id="cv" className={h2}>{t("coverage")}</h2>
        {coverage.stories ? (
          <>
            <p className="meta mb-2">
              {t("coverageMix", { stories: coverage.stories })}: {coverage.mix.map((m) => `${m.coverage === "unset" ? t("unset") : m.coverage} ${Math.round((m.stories / coverage.stories) * 100)}%`).join(" · ")}
            </p>
            <Table caption={t("coverage")}>
              <thead><tr><Th>{t("source")}</Th><Th>{t("perspective")}</Th><Th>{t("section")}</Th><Th className="text-end">{t("stories")}</Th><Th className="text-end">{t("primary")}</Th><Th className="w-[20%]">{t("share")}</Th></tr></thead>
              <tbody>{coverage.bySource.map((s) => (
                <tr key={`${s.name}-${s.group}`}>
                  <Td className="whitespace-nowrap">{s.name}</Td><Td className="text-ink-2">{s.perspective || "—"}</Td><Td>{s.group}</Td>
                  <Td className="text-end tabular-nums">{nf.format(s.stories)}</Td><Td className="text-end tabular-nums">{nf.format(s.primary)}</Td>
                  <Td><span className="flex items-center gap-2"><Bar value={s.stories} max={coverage.stories} tone="now" /><span className="tabular-nums">{Math.round((s.stories / coverage.stories) * 100)}%</span></span></Td>
                </tr>
              ))}</tbody>
            </Table>
          </>
        ) : <Empty>{t("noData")}</Empty>}
      </section>
    </AdminShell>
  );
}
