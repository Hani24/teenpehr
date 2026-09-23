import { requireAdmin } from "@/lib/admin/session";
import { listHandles, listGroups } from "@/lib/admin/data";
import { addHandle, toggleHandle, deleteHandle } from "@/lib/admin/actions";
import { ago } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { Field, Input, Select, Button } from "@/components/admin/form";
import { ConfirmButton } from "@/components/admin/confirm-button";

export const dynamic = "force-dynamic";

export default async function HandlesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const group = (Array.isArray(sp.group) ? sp.group[0] : sp.group) ?? "";
  const [rows, groups, flash] = await Promise.all([listHandles(group || undefined), listGroups(), flashFrom(searchParams)]);
  return (
    <AdminShell title={`Handles (${rows.length})`} flash={flash}>
      <form action={addHandle} className="card mb-4 grid gap-2 p-3 sm:grid-cols-6">
        <Field label="Platform"><Select name="platform" options={[["x", "X"], ["bluesky", "Bluesky"], ["telegram", "Telegram"], ["youtube", "YouTube"]]} /></Field>
        <Field label="Handle"><Input name="handle" placeholder="HamidMirPAK" required /></Field>
        <Field label="Display name"><Input name="display_name" /></Field>
        <Field label="Role"><Select name="role" options={[["journalist", "journalist"], ["outlet", "outlet"], ["official", "official"], ["analyst", "analyst"]]} /></Field>
        <Field label="Group"><Select name="group_id" options={groups.map((g) => [String(g.id), g.nameEn])} /></Field>
        <div className="flex items-end"><Button tone="primary">Add</Button></div>
      </form>
      <form method="get" className="mb-3 flex items-end gap-2">
        <Select name="group" defaultValue={group} aria-label="Group" options={[["", "All groups"], ...groups.map((g) => [g.slug, g.nameEn] as [string, string])]} className="!w-auto" />
        <Button>Filter</Button>
      </form>
      {rows.length === 0 ? <Empty>No handles.</Empty> : (
        <Table caption="Watched handles">
          <thead><tr><Th>Platform</Th><Th>Handle</Th><Th>Name</Th><Th>Role</Th><Th>Group</Th><Th>Last post</Th><Th>Fallback used</Th><Th>Active</Th><Th></Th></tr></thead>
          <tbody>
            {rows.map(({ h, groupName }) => (
              <tr key={h.id} className={h.active ? "" : "opacity-60"}>
                <Td>{h.platform}</Td><Td className="font-semibold">{h.platform === "x" ? "@" : ""}{h.handle}</Td><Td>{h.displayName}</Td><Td>{h.role}</Td><Td>{groupName}</Td>
                <Td>{ago(h.lastPostAt)}</Td><Td>{h.fallbackUsedAt ? ago(h.fallbackUsedAt) : "—"}</Td>
                <Td><form action={toggleHandle}><input type="hidden" name="id" value={h.id} /><button type="submit" className="chip" aria-pressed={h.active}>{h.active ? "on" : "off"}</button></form></Td>
                <Td><form action={deleteHandle}><input type="hidden" name="id" value={h.id} /><ConfirmButton confirmLabel="Confirm">Delete</ConfirmButton></form></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </AdminShell>
  );
}
