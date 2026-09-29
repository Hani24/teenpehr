import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin/session";
import { roleAtLeast } from "@/lib/auth";
import { FEEDBACK_REASONS } from "@/lib/codes";
import { feedbackBy, feedbackOverTime, feedbackTotals, REASON_LABELS, topStories, WINDOWS, type Breakdown, type StoryVotes, type Window } from "@/lib/admin/feedback-insights";
import { AdminShell } from "@/components/admin/shell";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { ChipNav, Stat } from "../stories/_ui";
import { VoteBar, VoteLegend } from "./_charts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reader feedback" };

const nf = new Intl.NumberFormat("en-GB");
const dayLabel = (d: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

export default async function FeedbackPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin("/admin/feedback");
  const sp = await searchParams;
  const raw = Number(Array.isArray(sp.days) ? sp.days[0] : sp.days);
  const days: Window = (WINDOWS as readonly number[]).includes(raw) ? (raw as Window) : 30;
  const [totals, time, byGroup, byTopic, bySource, byEntity, byTag, byOrigin, liked, less] = await Promise.all([
    feedbackTotals(days), feedbackOverTime(days), feedbackBy("group", days), feedbackBy("topic", days), feedbackBy("source", days, 30),
    feedbackBy("entity", days, 25), feedbackBy("tag", days), feedbackBy("origin", days), topStories(days, 1), topStories(days, -1),
  ]);
  const owner = roleAtLeast(user.role, "owner");
  const h2 = "mb-2 mt-8 text-lg font-semibold";
  const noVotes = totals.up + totals.down === 0;
  return (
    <AdminShell title="Reader feedback" actions={owner ? <Link href="/admin/feedback/readers" className="chip min-h-11 px-3">Reader profiles</Link> : undefined}>
      <p className="meta mb-3 max-w-3xl">
        Readers mark a story &ldquo;Relevant to me&rdquo; or &ldquo;Show less like this&rdquo; (with optional reasons): relevance to them, not approval of the event.
        This feeds insights and, later, a personal &ldquo;For you&rdquo; order that may reweight topics and sections only. It never hides a story from the shared
        edition, and outlets are never ranked by it: their perspectives stay in every reader&apos;s edition.
      </p>
      <ChipNav label="Period" items={WINDOWS.map((w) => ({ href: `/admin/feedback?days=${w}`, label: `Last ${w} days`, current: w === days }))} />

      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Stat label="Relevant to me" value={nf.format(totals.up)} />
        <Stat label="Show less like this" value={nf.format(totals.down)} sub={totals.down ? `${nf.format(totals.withReasons)} with a reason` : undefined} />
        <Stat label="Readers who voted" value={nf.format(totals.voters)} />
        <Stat label="Stories voted on" value={nf.format(totals.stories)} />
        <Stat label="Open mistake reports" value={nf.format(totals.reportsOpen)} tone={totals.reportsOpen ? "bad" : undefined} sub={<Link href="/admin/reports">Reports queue</Link>} />
      </div>

      {noVotes ? (
        <Empty>No votes in the last {days} days. They appear here as readers use the two buttons under each story.</Empty>
      ) : (
        <>
          <section aria-labelledby="rs">
            <h2 id="rs" className={h2}>Why readers wanted less</h2>
            <Table caption="Reasons given with Show less like this">
              <thead><tr><Th>Reason</Th><Th className="text-end">Votes</Th><Th className="text-end">Share of &ldquo;show less&rdquo;</Th></tr></thead>
              <tbody>
                {FEEDBACK_REASONS.map((r) => (
                  <tr key={r}><Td>{REASON_LABELS[r]}</Td><Td className="text-end tabular-nums">{nf.format(totals.reasons[r])}</Td>
                    <Td className="text-end tabular-nums">{totals.down ? `${Math.round((totals.reasons[r] / totals.down) * 100)}%` : "—"}</Td></tr>
                ))}
                <tr><Td className="text-ink-2">No reason given</Td><Td className="text-end tabular-nums text-ink-2">{nf.format(totals.down - totals.withReasons)}</Td><Td className="text-end tabular-nums text-ink-2">{totals.down ? `${Math.round(((totals.down - totals.withReasons) / totals.down) * 100)}%` : "—"}</Td></tr>
              </tbody>
            </Table>
            <p className="meta mt-1">A vote may give several reasons, so the shares can add up to more than 100%.</p>
          </section>

          <section aria-labelledby="ot">
            <h2 id="ot" className={h2}>Over time ({time.unit === "week" ? "by week" : "by day"}, Karachi time)</h2>
            <VoteLegend />
            <Table caption="Votes over time">
              <thead><tr><Th>{time.unit === "week" ? "Week of" : "Day"}</Th><Th className="w-[30%]">Show less · Relevant</Th><Th className="text-end">Relevant</Th><Th className="text-end">Show less</Th>
                {FEEDBACK_REASONS.map((r) => <Th key={r} className="text-end">{REASON_LABELS[r]}</Th>)}</tr></thead>
              <tbody>
                {time.rows.map((r) => {
                  const max = Math.max(1, ...time.rows.flatMap((x) => [x.up, x.down]));
                  return (
                    <tr key={r.bucket}>
                      <Td className="whitespace-nowrap">{dayLabel(r.bucket)}</Td><Td><VoteBar up={r.up} down={r.down} max={max} /></Td>
                      <Td className="text-end tabular-nums">{nf.format(r.up)}</Td><Td className="text-end tabular-nums">{nf.format(r.down)}</Td>
                      {FEEDBACK_REASONS.map((x) => <Td key={x} className={`text-end tabular-nums ${r.reasons[x] ? "" : "text-ink-3"}`}>{r.reasons[x] ? nf.format(r.reasons[x]) : "·"}</Td>)}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </section>

          <div className="grid gap-x-6 2xl:grid-cols-2">
            <BreakdownSection id="bg" title="By section" rows={byGroup} nameHeader="Section" h2={h2} />
            <BreakdownSection id="bt" title="By topic" rows={byTopic} nameHeader="Topic" h2={h2} href={(r) => `/en/topic/${r.key}`} empty="No voted story has a topic yet." />
          </div>
          <BreakdownSection id="bs" title="By outlet cited" rows={bySource} nameHeader="Outlet" h2={h2}
            note="Every outlet a story cites shares its votes. For editors to read only: outlets are never ranked or hidden by reader feedback." />
          <div className="grid gap-x-6 2xl:grid-cols-2">
            <BreakdownSection id="be" title="By person, organisation or place named" rows={byEntity} nameHeader="Name" h2={h2} href={(r) => `/en/entity/${r.key}`} empty="No voted story names an entity yet." />
            <div>
              <BreakdownSection id="btg" title="By tag" rows={byTag} nameHeader="Tag" h2={h2} />
              <BreakdownSection id="bo" title="Worker's stories and editors' manual stories" rows={byOrigin} nameHeader="Written by" h2={h2} />
            </div>
          </div>

          <div className="grid gap-x-6 xl:grid-cols-2">
            <StoryList id="tl" title="Most “relevant to me”" rows={liked} h2={h2} />
            <StoryList id="tm" title="Most “show less like this”" rows={less} h2={h2} />
          </div>
        </>
      )}
    </AdminShell>
  );
}

function BreakdownSection({ id, title, rows, nameHeader, h2, href, note, empty = "No votes." }: {
  id: string; title: string; rows: Breakdown[]; nameHeader: string; h2: string; href?: (r: Breakdown) => string; note?: string; empty?: string;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.up, r.down]));
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className={h2}>{title}</h2>
      {note && <p className="meta mb-2">{note}</p>}
      {rows.length === 0 ? <Empty>{empty}</Empty> : (
        <>
          <VoteLegend />
          <Table caption={title}>
            <thead><tr><Th>{nameHeader}</Th><Th className="w-[22%]">Show less · Relevant</Th><Th className="text-end">Relevant</Th><Th className="text-end">Less</Th><Th className="text-end">Readers</Th><Th>Reasons</Th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <Td className="min-w-32">
                    {href ? <Link href={href(r)} target="_blank" rel="noreferrer">{r.label}</Link> : r.label}
                    {r.extra && <span className="meta"> · {r.extra}</span>}
                    {r.labelUr && <span lang="ur" dir="rtl" className="meta block">{r.labelUr}</span>}
                  </Td>
                  <Td><VoteBar up={r.up} down={r.down} max={max} /></Td>
                  <Td className="text-end tabular-nums">{nf.format(r.up)}</Td>
                  <Td className="text-end tabular-nums">{nf.format(r.down)}</Td>
                  <Td className="text-end tabular-nums text-ink-2">{nf.format(r.voters)}</Td>
                  <Td className="meta min-w-32"><ReasonList reasons={r.reasons} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </section>
  );
}

/** Reason names short enough for a table cell (the full label is the tooltip and heads the reasons table). */
const SHORT_REASON: Record<(typeof FEEDBACK_REASONS)[number], string> = { topic: "topic", outlet: "outlet", too_much: "too much", not_for_me: "not for me" };

/** "Show less" reasons with their counts; wraps between reasons, never inside one. */
function ReasonList({ reasons }: { reasons: Breakdown["reasons"] }) {
  const given = FEEDBACK_REASONS.filter((x) => reasons[x]);
  if (!given.length) return <>—</>;
  return <>{given.map((x, i) => <span key={x}>{i > 0 && " · "}<span className="whitespace-nowrap" title={REASON_LABELS[x]}>{SHORT_REASON[x]} {nf.format(reasons[x])}</span></span>)}</>;
}

function StoryList({ id, title, rows, h2 }: { id: string; title: string; rows: StoryVotes[]; h2: string }) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className={h2}>{title}</h2>
      {rows.length === 0 ? <Empty>None.</Empty> : (
        <ol className="card divide-y divide-rule text-sm">
          {rows.map((s) => (
            <li key={s.id} className="px-3 py-2">
              <a href={`/en/story/${s.id}`} target="_blank" rel="noreferrer" className="font-semibold">{s.titleEn || <span lang="ur" dir="rtl">{s.titleUr}</span>}</a>
              <span className="meta block">
                {s.group} · {s.date} {s.slot}{s.origin === "manual" ? " · manual entry" : ""} · relevant {s.up} · show less {s.down}
                {FEEDBACK_REASONS.some((x) => s.reasons[x]) && <> ({FEEDBACK_REASONS.filter((x) => s.reasons[x]).map((x) => `${REASON_LABELS[x].toLowerCase()} ${s.reasons[x]}`).join(", ")})</>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
