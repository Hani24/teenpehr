import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/session";
import { getRun } from "@/lib/admin/data";
import { fmtDate, fmtDuration, fmtMoney } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { Table, Th, Td, Dot, StatusPill } from "@/components/admin/table";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const run = await getRun(id);
  if (!run) notFound();
  const ok = run.sources.filter((s) => s.ok).length;
  return (
    <AdminShell title={`Run #${run.id}`} actions={<StatusPill status={run.status} />}>
      <dl className="card mb-4 grid grid-cols-2 gap-x-4 gap-y-1 p-4 text-sm sm:grid-cols-4">
        <dt className="meta">Kind</dt><dd>{run.kind} {run.date ?? ""} {run.slot ?? ""}</dd>
        <dt className="meta">Model</dt><dd>{run.model ?? "—"}</dd>
        <dt className="meta">Started</dt><dd>{fmtDate(run.startedAt)}</dd>
        <dt className="meta">Duration</dt><dd>{fmtDuration(run.startedAt, run.finishedAt)}</dd>
        <dt className="meta">Tokens</dt><dd>{run.tokensIn.toLocaleString()} in · {run.tokensOut.toLocaleString()} out</dd>
        <dt className="meta">Cost</dt><dd>{fmtMoney(run.costUsd)}</dd>
        <dt className="meta">Sources</dt><dd>{ok} ok · {run.sources.length - ok} failed</dd>
        <dt className="meta">Error</dt><dd className="text-accent">{run.error ?? "—"}</dd>
      </dl>
      {run.sources.length > 0 && (
        <Table caption="Per-source results">
          <thead><tr><Th></Th><Th>Source</Th><Th>Items</Th><Th>ms</Th><Th>Tier</Th><Th>Route</Th><Th>Error</Th></tr></thead>
          <tbody>
            {run.sources.map((s) => (
              <tr key={s.id}>
                <Td><Dot tone={s.ok ? "ok" : "bad"} title={s.ok ? "ok" : "failed"} /></Td>
                <Td><Link href={`/admin/sources/${s.sourceId}`}>{s.source.name}</Link></Td><Td>{s.items}</Td><Td>{s.ms}</Td><Td>{s.tier}</Td><Td>{s.route}</Td><Td className="text-accent">{s.error ?? ""}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <h2 className="mb-2 mt-6 font-semibold">Log</h2>
      <pre className="card max-h-[60vh] overflow-auto p-3 text-xs whitespace-pre-wrap">{run.log || "(empty)"}</pre>
    </AdminShell>
  );
}
