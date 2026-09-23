import Link from "next/link";
import { requireAdmin } from "@/lib/admin/session";
import { listGroups } from "@/lib/admin/data";
import { moveGroup } from "@/lib/admin/actions";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Table, Th, Td } from "@/components/admin/table";

export const dynamic = "force-dynamic";

export default async function GroupsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const [groups, flash] = await Promise.all([listGroups(), flashFrom(searchParams)]);
  return (
    <AdminShell title="Groups" flash={flash}>
      <Table caption="Groups in reader order">
        <thead><tr><Th>Order</Th><Th>Name</Th><Th>Urdu</Th><Th>Stories</Th><Th>X lists</Th><Th>Hidden in</Th><Th>Active</Th></tr></thead>
        <tbody>
          {groups.map((g, i) => (
            <tr key={g.id} className={g.active ? "" : "opacity-60"}>
              <Td>
                <span className="inline-flex items-center gap-1">
                  <form action={moveGroup}><input type="hidden" name="id" value={g.id} /><input type="hidden" name="dir" value="up" /><button type="submit" className="chip" disabled={i === 0} aria-label={`Move ${g.nameEn} up`}>↑</button></form>
                  <form action={moveGroup}><input type="hidden" name="id" value={g.id} /><input type="hidden" name="dir" value="down" /><button type="submit" className="chip" disabled={i === groups.length - 1} aria-label={`Move ${g.nameEn} down`}>↓</button></form>
                </span>
              </Td>
              <Td><Link href={`/admin/groups/${g.id}`} className="font-semibold">{g.nameEn}</Link><br /><span className="meta">{g.slug}</span></Td>
              <Td lang="ur" dir="rtl">{g.nameUr}</Td><Td>{g.storyCount}</Td><Td>{g.xListIds.length ? g.xListIds.join(", ") : <span className="meta">none</span>}</Td>
              <Td>{g.hiddenInThemes.join(", ") || "—"}</Td><Td>{g.active ? "yes" : "no"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </AdminShell>
  );
}
