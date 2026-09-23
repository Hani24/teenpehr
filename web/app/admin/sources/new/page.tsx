import { requireAdmin } from "@/lib/admin/session";
import { listGroups } from "@/lib/admin/data";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { SourceForm } from "@/components/admin/source-form";

export const dynamic = "force-dynamic";

export default async function NewSourcePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const [groups, flash] = await Promise.all([listGroups(), flashFrom(searchParams)]);
  return <AdminShell title="New source" flash={flash}><SourceForm source={null} groups={groups} /></AdminShell>;
}
