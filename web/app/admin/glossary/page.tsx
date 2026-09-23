import { requireAdmin } from "@/lib/admin/session";
import { listGlossary } from "@/lib/admin/data";
import { saveGlossary, toggleGlossaryLock, deleteGlossary } from "@/lib/admin/actions";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { Field, Input, Select, Button } from "@/components/admin/form";
import { ConfirmButton } from "@/components/admin/confirm-button";

export const dynamic = "force-dynamic";
const kinds: Array<[string, string]> = [["person", "person"], ["place", "place"], ["org", "org"], ["other", "other"]];

export default async function GlossaryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? "";
  const [rows, flash] = await Promise.all([listGlossary(q || undefined), flashFrom(searchParams)]);
  return (
    <AdminShell title={`Glossary (${rows.length})`} flash={flash}>
      <form action={saveGlossary} className="card mb-4 grid gap-2 p-3 sm:grid-cols-4">
        <Field label="English"><Input name="term_en" required /></Field>
        <Field label="Urdu"><Input name="term_ur" lang="ur" dir="rtl" required /></Field>
        <Field label="Kind"><Select name="kind" options={kinds} /></Field>
        <div className="flex items-end"><Button tone="primary">Add term</Button></div>
      </form>
      <form method="get" className="mb-3 flex items-end gap-2"><Input name="q" defaultValue={q} placeholder="Search" aria-label="Search" className="!w-64" /><Button>Search</Button></form>
      {rows.length === 0 ? <Empty>No terms.</Empty> : (
        <Table caption="Glossary">
          <thead><tr><Th>English</Th><Th>Urdu</Th><Th>Kind</Th><Th>Locked</Th><Th></Th></tr></thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.id}>
                <Td colSpan={3} className="!p-0">
                  <form action={saveGlossary} className="grid grid-cols-[1fr_1fr_8rem_auto] items-center gap-2 p-1.5">
                    <input type="hidden" name="id" value={g.id} />
                    <Input name="term_en" defaultValue={g.termEn} aria-label="English" />
                    <Input name="term_ur" defaultValue={g.termUr} lang="ur" dir="rtl" aria-label="Urdu" />
                    <Select name="kind" defaultValue={g.kind} options={kinds} aria-label="Kind" />
                    <Button>Save</Button>
                  </form>
                </Td>
                <Td><form action={toggleGlossaryLock}><input type="hidden" name="id" value={g.id} /><button type="submit" className="chip" aria-pressed={g.locked}>{g.locked ? "locked" : "open"}</button></form></Td>
                <Td><form action={deleteGlossary}><input type="hidden" name="id" value={g.id} /><ConfirmButton confirmLabel="Confirm">Delete</ConfirmButton></form></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </AdminShell>
  );
}
