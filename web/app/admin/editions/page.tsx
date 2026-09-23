import Link from "next/link";
import { requireAdmin } from "@/lib/admin/session";
import { listEditions } from "@/lib/admin/data";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Table, Th, Td, StatusPill, Empty } from "@/components/admin/table";

export const dynamic = "force-dynamic";

export default async function EditionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const [rows, flash] = await Promise.all([listEditions(), flashFrom(searchParams)]);
  return (
    <AdminShell title="Editions" flash={flash}>
      {rows.length === 0 ? <Empty>No editions yet.</Empty> : (
        <Table caption="Editions, newest first">
          <thead><tr><Th>Date</Th><Th>Slot</Th><Th>Status</Th><Th>Stories</Th><Th>Flagged</Th><Th>Published</Th><Th>Run</Th><Th>Public</Th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <Td><Link href={`/admin/editions/${e.id}`} className="font-semibold">{e.date}</Link></Td><Td>{e.slot}</Td><Td><StatusPill status={e.status} /></Td>
                <Td>{e.n}</Td><Td className={e.flagged ? "text-accent" : ""}>{e.flagged}</Td><Td>{fmtDate(e.publishedAt)}</Td>
                <Td>{e.runId ? <Link href={`/admin/runs/${e.runId}`}>#{e.runId}</Link> : "—"}</Td>
                <Td>{e.status === "published" ? <a href={`/en/${e.date}/${e.slot}`} target="_blank" rel="noreferrer">open ↗</a> : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </AdminShell>
  );
}
