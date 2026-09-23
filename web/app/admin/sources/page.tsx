import Link from "next/link";
import { requireAdmin } from "@/lib/admin/session";
import { listSources, listGroups } from "@/lib/admin/data";
import { toggleSource } from "@/lib/admin/actions";
import { ago } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Table, Th, Td, Dot, Empty } from "@/components/admin/table";
import { Select, Input, Button } from "@/components/admin/form";

export const dynamic = "force-dynamic";
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function SourcesPage({ searchParams }: { searchParams: SP }) {
  await requireAdmin();
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const filter = { group: one("group"), kind: one("kind"), route: one("route"), active: one("active"), q: one("q") };
  const [rows, groups, flash] = await Promise.all([listSources(filter), listGroups(), flashFrom(searchParams)]);
  return (
    <AdminShell title={`Sources (${rows.length})`} flash={flash} actions={<Link href="/admin/sources/new" className="chip font-semibold">+ New source</Link>}>
      <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
        <Select name="group" defaultValue={filter.group} aria-label="Group" options={[["", "All groups"], ...groups.map((g) => [g.slug, g.nameEn] as [string, string])]} className="!w-auto" />
        <Select name="kind" defaultValue={filter.kind} aria-label="Kind" options={[["", "All kinds"], ["rss", "rss"], ["gnews", "gnews"], ["youtube", "youtube"], ["html", "html"], ["telegram", "telegram"]]} className="!w-auto" />
        <Select name="route" defaultValue={filter.route} aria-label="Route" options={[["", "All routes"], ["direct", "direct"], ["germany", "germany"]]} className="!w-auto" />
        <Select name="active" defaultValue={filter.active} aria-label="Active" options={[["", "Active and inactive"], ["1", "Active only"], ["0", "Inactive only"]]} className="!w-auto" />
        <Input name="q" defaultValue={filter.q} placeholder="Search name or URL" aria-label="Search" className="!w-56" />
        <Button>Filter</Button>
      </form>
      {rows.length === 0 ? <Empty>No sources match.</Empty> : (
        <Table caption="Sources">
          <thead><tr><Th></Th><Th>Name</Th><Th>Group</Th><Th>Kind</Th><Th>Lang</Th><Th>Route</Th><Th>Max</Th><Th>Last OK</Th><Th>Fails</Th><Th>Active</Th></tr></thead>
          <tbody>
            {rows.map(({ s, groupName }) => {
              const tone = !s.active ? "off" : s.failStreak >= 3 ? "bad" : s.failStreak > 0 ? "warn" : s.lastOkAt ? "ok" : "off";
              return (
                <tr key={s.id} className={s.active ? "" : "opacity-60"}>
                  <Td><Dot tone={tone} title={`fail streak ${s.failStreak}, last ok ${ago(s.lastOkAt)}`} /></Td>
                  <Td><Link href={`/admin/sources/${s.id}`} className="font-semibold">{s.name}</Link><br /><span className="meta break-all">{s.url.slice(0, 70)}</span></Td>
                  <Td>{groupName}</Td><Td>{s.kind}</Td><Td>{s.lang}</Td><Td>{s.route}</Td><Td>{s.maxItems}</Td><Td>{ago(s.lastOkAt)}</Td><Td>{s.failStreak}</Td>
                  <Td><form action={toggleSource}><input type="hidden" name="id" value={s.id} /><button type="submit" className="chip" aria-pressed={s.active}>{s.active ? "on" : "off"}</button></form></Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </AdminShell>
  );
}
