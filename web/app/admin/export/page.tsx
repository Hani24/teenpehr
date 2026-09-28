import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { DATASETS } from "./_datasets";
import { AdminShell } from "@/components/admin/shell";
import { Table, Th, Td } from "@/components/admin/table";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Exports" };

const nf = new Intl.NumberFormat("en-GB");

/** Owner-only research downloads (decision D5): each table as CSV or JSONL, streamed. */
export default async function ExportPage() {
  await requireRole("owner", { locale: "en", next: "/admin/export" });
  const counts = await Promise.all(Object.values(DATASETS).map((d) => d.count()));
  return (
    <AdminShell title="Exports">
      <p className="meta mb-4 max-w-3xl">
        Everything is kept (decision D5), so these files grow with the archive. CSV opens in a spreadsheet: lists and JSON values are written as JSON, and text that
        starts with = + - or @ gets a leading &apos; so a spreadsheet never runs it as a formula. JSONL has one JSON object per line with the values exactly as stored.
      </p>
      <Table caption="Research exports">
        <thead><tr><Th>Dataset</Th><Th>What it holds</Th><Th className="text-end">Rows</Th><Th>Download</Th></tr></thead>
        <tbody>
          {Object.entries(DATASETS).map(([key, d], i) => (
            <tr key={key}>
              <Td className="whitespace-nowrap font-semibold">{d.title}</Td>
              <Td className="max-w-xl text-ink-2">{d.description}</Td>
              <Td className="text-end tabular-nums">{nf.format(counts[i])}</Td>
              <Td className="whitespace-nowrap">
                {/* Plain links: a download must not be prefetched. No `download` attribute: the route sends it as a
                    file, and a session that has ended must show the sign-in page, not save it as the file. */}
                <a href={`/admin/export/${key}?format=csv`} className="chip">CSV</a>{" "}
                <a href={`/admin/export/${key}?format=jsonl`} className="chip">JSONL</a>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </AdminShell>
  );
}
