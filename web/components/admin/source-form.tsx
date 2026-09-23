import { saveSource, deleteSource, testFetch } from "@/lib/admin/actions";
import { Field, Input, Select, Textarea, Checkbox, Button } from "@/components/admin/form";
import { ActionForm } from "@/components/admin/action-form";
import { ConfirmButton } from "@/components/admin/confirm-button";
import type { schema } from "@/db";

type Source = typeof schema.sources.$inferSelect;
type Group = typeof schema.groups.$inferSelect;

export function SourceForm({ source, groups }: { source: Source | null; groups: Group[] }) {
  const s = source;
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
        <div className="flex items-end"><Checkbox name="active" label="Active" defaultChecked={s?.active ?? true} /></div>
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
          <div className="card p-4">
            <h2 className="mb-2 font-semibold">Danger zone</h2>
            <p className="meta mb-2">Deleting removes the source and every item fetched from it.</p>
            <form action={deleteSource}><input type="hidden" name="id" value={s.id} /><ConfirmButton>Delete source</ConfirmButton></form>
          </div>
        )}
      </div>
    </div>
  );
}
