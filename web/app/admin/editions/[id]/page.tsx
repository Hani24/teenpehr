import Link from "next/link";
import { notFound } from "next/navigation";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin/session";
import { getEditionById, getEditionGroupLeads } from "@/lib/admin/data";
import { publishEdition, holdEdition, releaseEdition, updateLead } from "@/lib/admin/actions";
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
  // Who hid a story's image (D6): shown in that story's block.
  const hiderIds = [...new Set(ed.stories.map((s) => s.imageHiddenBy).filter((x): x is number => x != null))];
  const hiders = new Map(hiderIds.length
    ? (await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, hiderIds))).map((u) => [u.id, u.name || u.email])
    : []);
  const flagged = ed.stories.filter((s) => s.qaStatus === "flagged").length;
  const actions = editable ? (
    <>
      {ed.status === "review"
        ? <form action={releaseEdition}><input type="hidden" name="id" value={ed.id} /><Button title="Back to draft so a worker rerun of this slot can replace it">Release hold</Button></form>
        : <form action={holdEdition}><input type="hidden" name="id" value={ed.id} /><Button title="Keep it off the site and stop the worker overwriting it">Hold for review</Button></form>}
      <form action={publishEdition} className="flex items-center gap-2"><input type="hidden" name="id" value={ed.id} />{flagged > 0 && <Checkbox name="force" label={`publish despite ${flagged} flagged`} />}<Button tone="primary">Publish</Button></form>
    </>
  ) : <a href={`/en/${ed.date}/${ed.slot}`} target="_blank" rel="noreferrer" className="chip">View public ↗</a>;
  return (
    <AdminShell title={`${ed.date} · ${ed.slot}`} flash={flash} actions={actions}>
      <p className="meta mb-4"><StatusPill status={ed.status} /> · {ed.stories.length} stories · {flagged} flagged · published {fmtDate(ed.publishedAt)} · run {ed.runId ? <Link href={`/admin/runs/${ed.runId}`}>#{ed.runId}</Link> : "—"}{ed.snapshotPath && <> · snapshot {ed.snapshotPath}</>}</p>
      {ed.status === "review" && <p className="meta mb-4">Held: the worker skips this slot. Release the hold to let a rerun (<code>uv run teenpehr edition --date {ed.date} --slot {ed.slot}</code> in <code>worker/</code>) replace it; that discards edits made here.</p>}
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
            ) : <p className="mb-3 text-sm"><span className="font-semibold">Lead:</span> {g.leadEn} <span lang="ur" dir="rtl" className="ms-3">{g.leadUr}</span></p>}
            <div className="space-y-4">{stories.map((s) => <StoryEditor key={s.id} story={s} editionId={ed.id} editable={editable} hiderName={s.imageHiddenBy != null ? hiders.get(s.imageHiddenBy) ?? null : null} />)}</div>
          </section>
        );
      })}
    </AdminShell>
  );
}
