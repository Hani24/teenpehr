import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/session";
import { getGroup } from "@/lib/admin/data";
import { updateGroup, saveTopics } from "@/lib/admin/actions";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Field, Input, Textarea, Checkbox, Button } from "@/components/admin/form";
import { HIDE_IN_MODES } from "@/lib/view";
import en from "@/messages/en.json";

export const dynamic = "force-dynamic";

export default async function GroupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [g, flash] = await Promise.all([getGroup(id), flashFrom(searchParams)]);
  if (!g) notFound();
  const topic = g.topics[0];
  /** Ids from when palettes could hide groups; not honoured any more. */
  const stale = g.hiddenInThemes.filter((id) => !(HIDE_IN_MODES as readonly string[]).includes(id));
  return (
    <AdminShell title={g.nameEn} flash={flash}>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <form action={updateGroup} className="card grid gap-3 p-4 sm:grid-cols-2">
          <input type="hidden" name="id" value={g.id} />
          <Field label="Name (English)"><Input name="name_en" defaultValue={g.nameEn} required /></Field>
          <Field label="Name (Urdu)"><Input name="name_ur" defaultValue={g.nameUr} lang="ur" dir="rtl" required /></Field>
          <Field label="Editor brief" hint="What matters to this audience and what to skip. Sent to the curation prompt." className="sm:col-span-2"><Textarea name="brief" defaultValue={g.brief} className="min-h-40" /></Field>
          <Field label="Stories per edition"><Input name="story_count" type="number" min={1} max={30} defaultValue={g.storyCount} /></Field>
          <div className="flex items-end"><Checkbox name="active" label="Active" defaultChecked={g.active} /></div>
          <Field label="X list ids" hint="Public X List ids for this group's handles, comma-separated" className="sm:col-span-2"><Textarea name="x_list_ids" defaultValue={g.xListIds.join(", ")} className="min-h-16" /></Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-sm font-semibold">Hidden in reading mode</legend>
            <p className="meta mb-2">Readers who turn this mode on do not see the group on edition pages; it stays in its section page and the archive.</p>
            <div className="flex flex-wrap gap-4">
              {HIDE_IN_MODES.map((id) => <Checkbox key={id} name="hidden_in_themes" value={id} label={`${en[id].name}: ${en[id].description}`} defaultChecked={g.hiddenInThemes.includes(id)} />)}
            </div>
            {stale.length > 0 && <p className="meta mt-2">Also stored: {stale.join(", ")}. Palettes no longer hide groups; saving removes {stale.length === 1 ? "it" : "them"}.</p>}
          </fieldset>
          <div className="sm:col-span-2"><Button tone="primary">Save group</Button></div>
        </form>
        <form action={saveTopics} className="card grid gap-3 p-4">
          <h2 className="font-semibold">Topics</h2>
          <input type="hidden" name="group_id" value={g.id} />
          <Field label="Keywords (English)" hint="Comma-separated; steer relevance, not a hard filter"><Textarea name="keywords_en" defaultValue={topic?.keywordsEn.join(", ") ?? ""} /></Field>
          <Field label="Keywords (Urdu)"><Textarea name="keywords_ur" defaultValue={topic?.keywordsUr.join(", ") ?? ""} lang="ur" dir="rtl" /></Field>
          <Field label="Boost (1–5)"><Input name="boost" type="number" min={1} max={5} defaultValue={topic?.boost ?? 1} /></Field>
          <div><Button>Save topics</Button></div>
        </form>
      </div>
    </AdminShell>
  );
}
