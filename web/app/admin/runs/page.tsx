import Link from "next/link";
import { requireAdmin } from "@/lib/admin/session";
import { listRuns } from "@/lib/admin/data";
import { fmtDate, fmtDuration, fmtMoney } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { Table, Th, Td, StatusPill, Empty } from "@/components/admin/table";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  await requireAdmin();
  const rows = await listRuns();
  return (
    <AdminShell title="Runs">
      {rows.length === 0 ? <Empty>No runs yet.</Empty> : (
        <Table caption="Worker runs">
          <thead><tr><Th>Run</Th><Th>Kind</Th><Th>Date · slot</Th><Th>Status</Th><Th>Model</Th><Th>Tokens in/out</Th><Th>Cost</Th><Th>Duration</Th><Th>Started</Th><Th>Error</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td><Link href={`/admin/runs/${r.id}`}>#{r.id}</Link></Td><Td>{r.kind}</Td><Td>{r.date ?? "—"} {r.slot ?? ""}</Td><Td><StatusPill status={r.status} /></Td>
                <Td>{r.model ?? "—"}</Td><Td>{r.tokensIn.toLocaleString()} / {r.tokensOut.toLocaleString()}</Td><Td>{fmtMoney(r.costUsd)}</Td>
                <Td>{fmtDuration(r.startedAt, r.finishedAt)}</Td><Td>{fmtDate(r.startedAt)}</Td><Td className="text-accent">{r.error?.slice(0, 80)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </AdminShell>
  );
}
