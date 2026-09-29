import type { Metadata } from "next";
import Link from "next/link";
import { requireOwner } from "@/lib/admin/session";
import { readersWithFeedback } from "@/lib/admin/feedback-insights";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { VoteBar } from "../_charts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reader profiles" };

const nf = new Intl.NumberFormat("en-GB");

/** Owner only: each reader's votes, reads and reports (D8). Personal data: never shown to editors. */
export default async function ReadersPage() {
  await requireOwner("/admin/feedback/readers");
  const rows = await readersWithFeedback();
  const active = rows.filter((r) => r.up + r.down + r.reads + r.reports > 0);
  const max = Math.max(1, ...active.flatMap((r) => [r.up, r.down]));
  return (
    <AdminShell title="Reader profiles" actions={<Link href="/admin/feedback" className="chip">Feedback overview</Link>}>
      <p className="meta mb-4 max-w-3xl">
        Owners only. What each reader told us is relevant or wanted less of, and what they read: the basis for a later &ldquo;For you&rdquo; order, which will
        only reweight topics and sections. No personal ranking is in use yet.
      </p>
      {active.length === 0 ? <Empty>No reader has voted, read or reported anything yet.</Empty> : (
        <Table caption="Readers">
          <thead><tr><Th>Reader</Th><Th className="w-[22%]">Show less · Relevant</Th><Th className="text-end">Relevant</Th><Th className="text-end">Less</Th><Th className="text-end">Stories read</Th><Th className="text-end">Reports</Th><Th>Last vote</Th></tr></thead>
          <tbody>
            {active.map((r) => (
              <tr key={r.id} className={r.status === "disabled" ? "opacity-60" : ""}>
                <Td><Link href={`/admin/feedback/readers/${r.id}`} className="font-semibold"><bdi>{r.name || r.email}</bdi></Link><span className="meta block">{r.email} · {r.role}{r.status === "disabled" ? " · switched off" : ""}</span></Td>
                <Td><VoteBar up={r.up} down={r.down} max={max} /></Td>
                <Td className="text-end tabular-nums">{nf.format(r.up)}</Td>
                <Td className="text-end tabular-nums">{nf.format(r.down)}</Td>
                <Td className="text-end tabular-nums">{nf.format(r.reads)}</Td>
                <Td className="text-end tabular-nums">{nf.format(r.reports)}</Td>
                <Td className="whitespace-nowrap">{fmtDate(r.lastVote)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {rows.length > active.length && <p className="meta mt-2">{rows.length - active.length} more account{rows.length - active.length === 1 ? " has" : "s have"} no votes, reads or reports yet.</p>}
    </AdminShell>
  );
}
