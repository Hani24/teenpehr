import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/session";
import { getSource, listGroups } from "@/lib/admin/data";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { SourceForm } from "@/components/admin/source-form";
import { ago } from "@/lib/admin/util";

export const dynamic = "force-dynamic";

export default async function SourcePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [source, groups, flash] = await Promise.all([getSource(id), listGroups(), flashFrom(searchParams)]);
  if (!source) notFound();
  return (
    <AdminShell title={source.name} flash={flash} actions={<span className="meta">last ok {ago(source.lastOkAt)} · fail streak {source.failStreak}</span>}>
      <SourceForm source={source} groups={groups} />
    </AdminShell>
  );
}
