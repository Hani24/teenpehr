import { requireAdmin } from "@/lib/admin/session";
import { getSettings } from "@/lib/queries";
import { saveSettings } from "@/lib/admin/actions";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Field, Input, Textarea, Select, Button } from "@/components/admin/form";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const [s, flash] = await Promise.all([getSettings(), flashFrom(searchParams)]);
  const times = (s.edition_times as Record<string, string> | undefined) ?? {};
  const str = (k: string, d = "") => (typeof s[k] === "string" ? (s[k] as string) : d);
  return (
    <AdminShell title="Settings" flash={flash}>
      <form action={saveSettings} className="card grid max-w-3xl gap-3 p-4 sm:grid-cols-3">
        <Field label="Subh (morning)"><Input name="subh" type="time" defaultValue={times.subh ?? "07:00"} required /></Field>
        <Field label="Dopahar (midday)"><Input name="dopahar" type="time" defaultValue={times.dopahar ?? "13:00"} required /></Field>
        <Field label="Shaam (evening)"><Input name="shaam" type="time" defaultValue={times.shaam ?? "19:30"} required /></Field>
        <Field label="Publish policy" hint="auto publishes unless stories are flagged; hold keeps every edition for approval"><Select name="publish_policy" defaultValue={str("publish_policy", "auto")} options={[["auto", "auto"], ["hold", "hold"]]} /></Field>
        <Field label="Editor name" hint="Shown on the disclosure line"><Input name="editor_name" defaultValue={str("editor_name")} /></Field>
        <Field label="Hijri adjustment (days)" hint="Set when the Ruet-e-Hilal date differs from the computed one"><Input name="hijri_adjust" type="number" min={-3} max={3} defaultValue={Number(s.hijri_adjust ?? 0)} /></Field>
        <Field label="Site name (EN)"><Input name="site_name_en" defaultValue={str("site_name_en", "Teen Pehr")} required /></Field>
        <Field label="Site name (UR)"><Input name="site_name_ur" defaultValue={str("site_name_ur", "تین پہر")} lang="ur" dir="rtl" required /></Field>
        <Field label="Default theme"><Select name="default_theme" defaultValue={str("default_theme", "classic")} options={[["classic", "classic"], ["night", "night"], ["buzurg", "buzurg"]]} /></Field>
        <Field label="Urdu digits"><Select name="digits_ur" defaultValue={str("digits_ur", "latn")} options={[["latn", "Western (1 2 3)"], ["arabext", "Urdu (۱ ۲ ۳)"]]} /></Field>
        <Field label="Disclosure (EN)" className="sm:col-span-3"><Textarea name="disclosure_en" defaultValue={str("disclosure_en")} className="!min-h-16" /></Field>
        <Field label="Disclosure (UR)" className="sm:col-span-3"><Textarea name="disclosure_ur" defaultValue={str("disclosure_ur")} lang="ur" dir="rtl" className="!min-h-16" /></Field>
        <Field label="Notification note" hint="ntfy topic is set in worker/.env; keep a reminder here" className="sm:col-span-3"><Input name="ntfy_note" defaultValue={str("ntfy_note")} /></Field>
        <div className="sm:col-span-3"><Button tone="primary">Save settings</Button></div>
      </form>
    </AdminShell>
  );
}
