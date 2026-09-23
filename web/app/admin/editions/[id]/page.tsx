import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/session";
import { getEditionById, getEditionGroupLeads } from "@/lib/admin/data";
import { publishEdition, holdEdition, updateLead } from "@/lib/admin/actions";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { StatusPill } from "@/components/admin/table";
import { Input, Button, Checkbox } from "@/components/admin/form";
import { StoryEditor } from "@/components/admin/story-editor";

export const dynamic = "force-dynamic";

export default async function EditionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [ed, leads, flash] = await Promise.all([getEditionById(id), getEditionGroupLeads(id), flashFrom(searchParams)]);
  if (!ed) notFound();
  const editable = ed.status !== "published";
  const flagged = ed.stories.filter((s) => s.qaStatus === "flagged").length;
  const actions = editable ? (
    <>
      <form action={holdEdition}><input type="hidden" name="id" value={ed.id} /><Button>Hold for review</Button></form>
      <form action={publishEdition} className="flex items-center gap-2"><input type="hidden" name="id" value={ed.id} />{flagged > 0 && <Checkbox name="force" label={`publish despite ${flagged} flagged`} />}<Button tone="primary">Publish</Button></form>
    </>
  ) : <a href={`/en/${ed.date}/${ed.slot}`} target="_blank" rel="noreferrer" className="chip">View public ↗</a>;
  return (
    <AdminShell title={`${ed.date} · ${ed.slot}`} flash={flash} actions={actions}>
      <p className="meta mb-4"><StatusPill status={ed.status} /> · {ed.stories.length} stories · {flagged} flagged · published {fmtDate(ed.publishedAt)} · run {ed.runId ? <Link href={`/admin/runs/${ed.runId}`}>#{ed.runId}</Link> : "—"}{ed.snapshotPath && <> · snapshot {ed.snapshotPath}</>}</p>
      {ed.groups.map((g) => {
        const lead = leads.find((l) => l.groupId === g.groupId);
        const stories = ed.stories.filter((s) => s.groupId === g.groupId).sort((a, b) => a.order - b.order);
        return (
          <section key={g.id} className="mb-8" aria-labelledby={`g-${g.id}`}>
            <h2 id={`g-${g.id}`} className="rule-strong mb-2 pt-2 text-lg font-bold">{g.group.nameEn} <span className="meta">{stories.length} stories · {g.itemCount} items read</span></h2>
            {editable && lead ? (
              <form action={updateLead} className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input type="hidden" name="edition_group_id" value={lead.id} /><input type="hidden" name="edition_id" value={ed.id} />
                <Input name="lead_en" defaultValue={lead.leadEn} placeholder="Lead (EN)" aria-label="Lead English" />
                <Input name="lead_ur" defaultValue={lead.leadUr} placeholder="Lead (UR)" aria-label="Lead Urdu" lang="ur" dir="rtl" />
                <Button>Save lead</Button>
              </form>
            ) : <p className="mb-3 text-sm"><span className="font-semibold">Lead:</span> {g.leadEn} <span lang="ur" dir="rtl" className="ml-3">{g.leadUr}</span></p>}
            <div className="space-y-4">{stories.map((s) => <StoryEditor key={s.id} story={s} editionId={ed.id} editable={editable} />)}</div>
          </section>
        );
      })}
    </AdminShell>
  );
}
