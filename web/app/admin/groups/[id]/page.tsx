import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/session";
import { roleAtLeast } from "@/lib/auth";
import { proposalsForGroup, PROPOSALS_FILE, type GroupProposal } from "@/lib/admin/x-proposals";
import { decideXListAction } from "@/lib/admin/manual-actions";
import { fmtDate } from "@/lib/admin/util";
import { getGroup } from "@/lib/admin/data";
import { updateGroup, saveTopics } from "@/lib/admin/actions";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Field, Input, Textarea, Checkbox, Button } from "@/components/admin/form";
import { HIDE_IN_MODES } from "@/lib/view";
import en from "@/messages/en.json";

export const dynamic = "force-dynamic";

export default async function GroupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [g, flash] = await Promise.all([getGroup(id), flashFrom(searchParams)]);
  if (!g) notFound();
  const { file, proposals } = await proposalsForGroup(g);
  const owner = roleAtLeast(user.role, "owner");
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
      <XListProposals groupId={g.id} groupName={g.nameEn} proposals={proposals} file={file} owner={owner} />
    </AdminShell>
  );
}

/**
 * Existing public X Lists proposed for this group (D10), from the research step's file and the decisions
 * recorded so far. Only an owner's "Add to group" puts a list id into the group; nothing else does.
 */
function XListProposals({ groupId, groupName, proposals, file, owner }: {
  groupId: number; groupName: string; proposals: GroupProposal[]; file: Awaited<ReturnType<typeof proposalsForGroup>>["file"]; owner: boolean;
}) {
  const open = proposals.filter((p) => p.status === "proposed");
  return (
    <section id="x-lists" aria-labelledby="x-lists-h" className="mt-8">
      <h2 id="x-lists-h" className="mb-1 text-lg font-semibold">Proposed public X Lists</h2>
      <p className="meta mb-3 max-w-3xl">
        Existing public lists found for {groupName} and checked live through X&apos;s embed (syndication) endpoint. {owner
          ? "Adding one puts its id in this group's X list ids; the X collector reads it from its next run."
          : "An owner decides which to add."}
        {" "}{file.path
          ? <>From <code>{PROPOSALS_FILE}</code>{file.generatedAt ? `, researched ${fmtDate(file.generatedAt)}` : file.modifiedAt ? `, updated ${fmtDate(file.modifiedAt)}` : ""}{file.skipped ? ` (the file has ${file.skipped} unreadable entr${file.skipped === 1 ? "y" : "ies"}, skipped)` : ""}.</>
          : <>No proposals file yet (<code>{PROPOSALS_FILE}</code>); the research step writes it.</>}
      </p>
      {file.error && <p role="alert" className="mb-3 text-sm text-accent">The proposals file could not be read: {file.error}</p>}
      {proposals.length === 0 ? (
        <p className="card p-6 text-center text-ink-2">No lists proposed for this group{file.path ? "" : " yet"}.</p>
      ) : (
        <ul className="grid gap-3">
          {proposals.map((p) => (
            <li key={p.listId} className={`card grid gap-2 p-4 text-sm ${p.status === "rejected" ? "opacity-70" : ""}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <a href={p.url} target="_blank" rel="noreferrer" className="font-semibold"><bdi>{p.name || `List ${p.listId}`}</bdi> ↗</a>
                <span className="meta">id {p.listId}{p.ownerHandle && <> · by <bdi>@{p.ownerHandle}</bdi></>}{p.memberCount != null && <> · {p.memberCount} members</>}</span>
                <span className={`pill ${p.status === "added" ? "pill-soft text-ok" : p.status === "rejected" ? "pill-soft" : "pill-soft text-warn"}`}>{p.status === "proposed" ? "awaiting a decision" : p.status === "added" ? "added" : "not for this group"}</span>
                {p.inGroup && <span className="pill pill-soft text-ok">in this group&apos;s list ids</span>}
              </div>
              <p className="meta">
                {p.verifiedAt ? `Checked ${fmtDate(p.verifiedAt)}` : "Not verified"}{p.postsSeen != null && `: ${p.postsSeen} posts returned`}{p.newestPostAt && `, newest ${fmtDate(p.newestPostAt)}`}
                {p.decidedAt && <> · decided {fmtDate(p.decidedAt)}{p.decidedBy ? ` by ${p.decidedBy}` : ""}</>}
              </p>
              {p.sampleHandles.length > 0 && <p className="meta">Members include {p.sampleHandles.map((h) => `@${h}`).join(", ")}</p>}
              {p.note && <p dir="auto" className="whitespace-pre-wrap">{p.note}</p>}
              {owner && (
                <form action={decideXListAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="group_id" value={groupId} /><input type="hidden" name="list_id" value={p.listId} />
                  {p.status !== "added" && !p.inGroup && <Button tone="primary" name="decision" value="add" className="min-h-11 px-4">Add to group</Button>}
                  {p.status === "proposed" && <Button name="decision" value="reject" className="min-h-11 px-4">Not for this group</Button>}
                  {p.status !== "proposed" && <Button name="decision" value="reopen" className="min-h-11 px-4">Back to proposed</Button>}
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {!owner && open.length > 0 && <p className="meta mt-2">{open.length} awaiting an owner&apos;s decision.</p>}
    </section>
  );
}
