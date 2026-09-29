import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/admin/session";
import { readerProfile, REASON_LABELS, type Affinity } from "@/lib/admin/feedback-insights";
import { FEEDBACK_REASONS } from "@/lib/codes";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { Stat } from "../../../stories/_ui";
import { VoteLegend, WeightBar } from "../../_charts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reader profile" };

const nf = new Intl.NumberFormat("en-GB");
const signed = (w: number) => `${w > 0 ? "+" : w < 0 ? "−" : ""}${Math.abs(w).toFixed(2)}`;

/** One reader's interest profile (D8), owners only. */
export default async function ReaderProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  await requireOwner(`/admin/feedback/readers/${Number.isInteger(id) ? id : ""}`);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) notFound();
  const p = await readerProfile(id);
  if (!p) notFound();
  const h2 = "mb-2 mt-8 text-lg font-semibold";
  return (
    <AdminShell title={p.user.name || p.user.email} actions={<Link href="/admin/feedback/readers" className="chip">All readers</Link>}>
      <p className="meta mb-4">{p.user.email} · {p.user.role}{p.user.status === "disabled" ? " · switched off" : ""} · joined {fmtDate(p.user.createdAt)} · last visit {fmtDate(p.user.lastVisitAt)}</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Relevant to me" value={nf.format(p.totals.up)} />
        <Stat label="Show less like this" value={nf.format(p.totals.down)} />
        <Stat label="Stories read" value={nf.format(p.totals.reads)} />
        <Stat label="Mistake reports" value={nf.format(p.reports.length)} />
      </div>
      <p className="meta mt-4 max-w-3xl rounded border border-rule p-3">
        <strong>Weight</strong> is a preview of how a later &ldquo;For you&rdquo; order could lean: (relevant − show less) ÷ (votes + 2), from −1 to +1. Reads are shown
        for context and are not in the weight. Only topics and sections would ever be reweighted; no story is hidden from the shared edition, and outlets get
        no weight at all. Nothing uses this yet.
      </p>

      <div className="grid gap-x-6 xl:grid-cols-2">
        <AffinityTable id="tp" title="Topics" rows={p.topics} h2={h2} empty="No votes or reads on stories with topics yet." />
        <AffinityTable id="gp" title="Sections" rows={p.groups} h2={h2} empty="No votes or reads yet." />
      </div>

      <div className="grid gap-x-6 xl:grid-cols-2">
        <section aria-labelledby="rs">
          <h2 id="rs" className={h2}>Reasons given</h2>
          <Table caption="Reasons given">
            <thead><tr><Th>Reason</Th><Th className="text-end">Times</Th></tr></thead>
            <tbody>{FEEDBACK_REASONS.map((r) => <tr key={r}><Td>{REASON_LABELS[r]}</Td><Td className="text-end tabular-nums">{nf.format(p.reasons[r])}</Td></tr>)}</tbody>
          </Table>
        </section>
        <section aria-labelledby="ol">
          <h2 id="ol" className={h2}>Outlets behind &ldquo;show less: outlet&rdquo;</h2>
          <p className="meta mb-2">The lead outlet of stories this reader wanted less of because of the outlet. For reading only: outlets are never personalised away.</p>
          {p.outlets.length === 0 ? <Empty>None.</Empty> : (
            <Table caption="Outlets named">
              <thead><tr><Th>Outlet</Th><Th>Perspective</Th><Th className="text-end">Stories</Th></tr></thead>
              <tbody>{p.outlets.map((o) => <tr key={o.name}><Td>{o.name}</Td><Td className="text-ink-2">{o.perspective || "—"}</Td><Td className="text-end tabular-nums">{o.stories}</Td></tr>)}</tbody>
            </Table>
          )}
        </section>
      </div>

      <section aria-labelledby="rv">
        <h2 id="rv" className={h2}>Latest votes</h2>
        {p.recent.length === 0 ? <Empty>No votes yet.</Empty> : (
          <Table caption="Latest votes">
            <thead><tr><Th>Story</Th><Th>Section</Th><Th>Vote</Th><Th>Reasons</Th><Th>When</Th></tr></thead>
            <tbody>
              {p.recent.map((r) => (
                <tr key={r.storyId}>
                  <Td><a href={`/en/story/${r.storyId}`} target="_blank" rel="noreferrer">{r.titleEn || <span lang="ur" dir="rtl">{r.titleUr}</span>}</a></Td>
                  <Td>{r.group}</Td>
                  <Td className="whitespace-nowrap">{r.value === 1 ? "Relevant to me" : "Show less"}</Td>
                  <Td className="meta">{r.reasons.map((x) => REASON_LABELS[x as keyof typeof REASON_LABELS] ?? x).join(", ") || "—"}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(r.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {p.reports.length > 0 && (
        <section aria-labelledby="rp">
          <h2 id="rp" className={h2}>Mistake reports</h2>
          <ul className="card divide-y divide-rule text-sm">
            {p.reports.map((r) => <li key={r.id} className="px-3 py-2"><Link href={`/admin/reports?status=${r.status}#report-${r.id}`}>Report #{r.id}</Link> on story #{r.storyId} · {r.status} · {fmtDate(r.createdAt)}</li>)}
          </ul>
        </section>
      )}
    </AdminShell>
  );
}

function AffinityTable({ id, title, rows, h2, empty }: { id: string; title: string; rows: Affinity[]; h2: string; empty: string }) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className={h2}>{title}</h2>
      {rows.length === 0 ? <Empty>{empty}</Empty> : (
        <>
          <VoteLegend />
          <Table caption={title}>
            <thead><tr><Th>{title.slice(0, -1)}</Th><Th className="w-[28%]">Weight</Th><Th className="text-end">Weight</Th><Th className="text-end">Relevant</Th><Th className="text-end">Less</Th><Th className="text-end">Read</Th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <Td>{r.label}<span lang="ur" dir="rtl" className="meta block">{r.labelUr}</span></Td>
                  <Td><WeightBar weight={r.weight} /></Td>
                  <Td className="text-end tabular-nums">{signed(r.weight)}</Td>
                  <Td className="text-end tabular-nums">{nf.format(r.up)}</Td>
                  <Td className="text-end tabular-nums">{nf.format(r.down)}</Td>
                  <Td className="text-end tabular-nums text-ink-2">{nf.format(r.reads)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </section>
  );
}
