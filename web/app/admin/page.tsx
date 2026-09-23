import Link from "next/link";
import { requireAdmin } from "@/lib/admin/session";
import { dashboard } from "@/lib/admin/data";
import { getSettings } from "@/lib/queries";
import { fmtDate, fmtDuration, fmtMoney } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { Table, Th, Td, StatusPill, Empty } from "@/components/admin/table";

export const dynamic = "force-dynamic";
const SLOTS = ["subh", "dopahar", "shaam"] as const;

export default async function Dashboard() {
  await requireAdmin();
  const [d, settings] = await Promise.all([dashboard(), getSettings()]);
  const times = (settings.edition_times as Record<string, string> | undefined) ?? {};
  return (
    <AdminShell title="Dashboard">
      <section aria-labelledby="today" className="mb-6">
        <h2 id="today" className="mb-2 font-semibold">Today, {d.today}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {SLOTS.map((slot) => {
            const e = d.todaysEditions.find((x) => x.slot === slot);
            return (
              <div key={slot} className="card p-3">
                <p className="font-semibold capitalize">{slot} <span className="meta">{times[slot] ?? ""}</span></p>
                <p className="mt-1">{e ? <Link href={`/admin/editions/${e.id}`}><StatusPill status={e.status} /></Link> : <span className="pill pill-soft">missing</span>}</p>
                {e?.publishedAt && <p className="meta">{fmtDate(e.publishedAt)}</p>}
              </div>
            );
          })}
        </div>
      </section>
      <section aria-labelledby="health" className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="card p-3"><p className="meta">Active sources</p><p className="text-2xl font-semibold">{Number(d.srcStats.active)} <span className="meta">of {Number(d.srcStats.total)}</span></p></div>
        <div className="card p-3"><p className="meta">Sources failing 3+ runs</p><p className={`text-2xl font-semibold ${Number(d.srcStats.failing) ? "text-accent" : ""}`}>{Number(d.srcStats.failing)}</p><Link href="/admin/sources?active=1" className="meta">Review sources</Link></div>
        <div className="card p-3"><p className="meta">Published editions</p><p className="text-2xl font-semibold">{d.published}</p><Link href="/admin/editions" className="meta">All editions</Link></div>
      </section>
      <section aria-labelledby="runs">
        <h2 id="runs" className="mb-2 font-semibold">Last 10 runs</h2>
        {d.recentRuns.length === 0 ? <Empty>No runs yet. The worker will appear here after its first edition.</Empty> : (
          <Table caption="Recent runs">
            <thead><tr><Th>Run</Th><Th>Kind</Th><Th>Date · slot</Th><Th>Status</Th><Th>Model</Th><Th>Items</Th><Th>Cost</Th><Th>Duration</Th><Th>Started</Th></tr></thead>
            <tbody>
              {d.recentRuns.map((r) => (
                <tr key={r.id}>
                  <Td><Link href={`/admin/runs/${r.id}`}>#{r.id}</Link></Td><Td>{r.kind}</Td><Td>{r.date ?? "—"} {r.slot ?? ""}</Td><Td><StatusPill status={r.status} /></Td>
                  <Td>{r.model ?? "—"}</Td><Td>{r.items}</Td><Td>{fmtMoney(r.costUsd)}</Td><Td>{fmtDuration(r.startedAt, r.finishedAt)}</Td><Td>{fmtDate(r.startedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </AdminShell>
  );
}
