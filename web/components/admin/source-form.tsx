import { saveSource, archiveSource, restoreSource, deleteSource, testFetch } from "@/lib/admin/actions";
import { Field, Input, Select, Textarea, Checkbox, Button } from "@/components/admin/form";
import { ActionForm } from "@/components/admin/action-form";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { fmtDate } from "@/lib/admin/util";
import type { schema } from "@/db";

type Source = typeof schema.sources.$inferSelect;
type Group = typeof schema.groups.$inferSelect;
type Usage = { items: number; runs: number; stories: number };

export function SourceForm({ source, groups, usage }: { source: Source | null; groups: Group[]; usage?: Usage }) {
  const s = source;
  const neverFetched = !!usage && usage.items === 0 && usage.runs === 0;
  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <form action={saveSource} className="card grid gap-3 p-4 sm:grid-cols-2">
        {s && <input type="hidden" name="id" value={s.id} />}
        <Field label="Name"><Input name="name" defaultValue={s?.name ?? ""} required /></Field>
        <Field label="Group"><Select name="group_id" defaultValue={String(s?.groupId ?? groups[0]?.id ?? "")} options={groups.map((g) => [String(g.id), g.nameEn])} /></Field>
        <Field label="URL" className="sm:col-span-2"><Input name="url" type="url" defaultValue={s?.url ?? ""} required /></Field>
        <Field label="Kind"><Select name="kind" defaultValue={s?.kind ?? "rss"} options={[["rss", "rss"], ["gnews", "gnews (Google News query)"], ["youtube", "youtube"], ["html", "html (no feed)"], ["telegram", "telegram"]]} /></Field>
        <Field label="Language" hint="en, ur, ar, fa, ug…"><Input name="lang" defaultValue={s?.lang ?? "en"} required /></Field>
        <Field label="Perspective label" hint="Shown to readers next to the outlet" className="sm:col-span-2"><Input name="perspective" defaultValue={s?.perspective ?? ""} /></Field>
        <Field label="Route" hint="germany = via the Hetzner SOCKS proxy for hosts blocked from Pakistan"><Select name="route" defaultValue={s?.route ?? "direct"} options={[["direct", "direct"], ["germany", "germany"]]} /></Field>
        <Field label="Fetcher tier" hint="0 feed · 1 impersonating HTTP · 2 stealth browser · 3 hosted"><Input name="fetcher_tier" type="number" min={0} max={3} defaultValue={s?.fetcherTier ?? 0} /></Field>
        <Field label="Max items per run"><Input name="max_items" type="number" min={1} max={100} defaultValue={s?.maxItems ?? 8} /></Field>
        <div className="flex items-end"><Checkbox name="active" label={s?.archivedAt ? "Active (restore first)" : "Active"} defaultChecked={s?.active ?? true} disabled={!!s?.archivedAt} /></div>
        <Field label="Notes" className="sm:col-span-2"><Textarea name="notes" defaultValue={s?.notes ?? ""} /></Field>
        <div className="sm:col-span-2"><Button tone="primary">{s ? "Save changes" : "Create source"}</Button></div>
      </form>
      <div className="space-y-4">
        <div className="card p-4">
          <h2 className="mb-2 font-semibold">Test fetch</h2>
          <ActionForm action={testFetch} submitLabel="Fetch now">
            <Field label="URL"><Input name="url" defaultValue={s?.url ?? ""} /></Field>
          </ActionForm>
        </div>
        {s && (
          <div className="card space-y-3 p-4">
            <h2 className="font-semibold">{s.archivedAt ? "Archived" : "Retire this source"}</h2>
            {usage && <p className="meta">{usage.items} items fetched · cited in {usage.stories} stories · {usage.runs} fetch records</p>}
            {s.archivedAt ? (
              <>
                <p className="text-sm">Archived {fmtDate(s.archivedAt)}. The worker skips it; its items stay cited in past editions.</p>
                <form action={restoreSource}><input type="hidden" name="id" value={s.id} /><Button>Restore source</Button></form>
              </>
            ) : (
              <>
                <p className="text-sm">Archiving stops fetching and hides it from the list. Its items and every citation in published editions stay.</p>
                <form action={archiveSource}><input type="hidden" name="id" value={s.id} /><Button tone="danger">Archive source</Button></form>
              </>
            )}
            {neverFetched ? (
              <form action={deleteSource} className="border-t border-rule pt-3">
                <p className="meta mb-2">Never fetched, so it can be deleted outright.</p>
                <input type="hidden" name="id" value={s.id} /><ConfirmButton>Delete source</ConfirmButton>
              </form>
            ) : <p className="meta border-t border-rule pt-3">Delete is only possible before the first fetch; archive keeps the history intact.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
