import { requireAdmin } from "@/lib/admin/session";
import { getSettings } from "@/lib/queries";
import { saveSettings } from "@/lib/admin/actions";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Field, Input, Textarea, Select, Button } from "@/components/admin/form";
import { SHIPPED_TIMES } from "@/lib/admin/util";
import { MODES, siteThemeDefaults, THEMES } from "@/lib/view";
import en from "@/messages/en.json";

export const dynamic = "force-dynamic";
const SLOTS = ["subh", "dopahar", "shaam"] as const;
/** What the worker uses while settings has no edition_times row. */
const SHIPPED: Record<(typeof SLOTS)[number], string> = SHIPPED_TIMES;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const [s, flash] = await Promise.all([getSettings(), flashFrom(searchParams)]);
  const times = (s.edition_times as Record<string, string> | undefined) ?? {};
  const str = (k: string, d = "") => (typeof s[k] === "string" ? (s[k] as string) : d);
  const current = Object.fromEntries(SLOTS.map((k) => [k, times[k] ?? SHIPPED[k]])) as typeof SHIPPED;
  const themeDefaults = siteThemeDefaults(s);
  return (
    <AdminShell title="Settings" flash={flash}>
      <form action={saveSettings} className="card grid max-w-3xl gap-3 p-4 sm:grid-cols-3">
        <Field label="Subh (morning)"><Input name="subh" type="time" defaultValue={current.subh} required /></Field>
        <Field label="Dopahar (midday)"><Input name="dopahar" type="time" defaultValue={current.dopahar} required /></Field>
        <Field label="Shaam (evening)"><Input name="shaam" type="time" defaultValue={current.shaam} required /></Field>
        <p className="meta -mt-1 sm:col-span-3">The worker makes each edition within 10 minutes of its time (Asia/Karachi). A change applies from the next check; see <a href="#worker-timer">Worker schedule</a>.</p>
        <Field label="Publish policy" hint="auto publishes unless stories are flagged; hold keeps every edition for approval"><Select name="publish_policy" defaultValue={str("publish_policy", "auto")} options={[["auto", "auto"], ["hold", "hold"]]} /></Field>
        <Field label="Editor name" hint="Shown on the disclosure line"><Input name="editor_name" defaultValue={str("editor_name")} /></Field>
        <Field label="Hijri adjustment (days)" hint="Set when the Ruet-e-Hilal date differs from the computed one"><Input name="hijri_adjust" type="number" min={-3} max={3} defaultValue={Number(s.hijri_adjust ?? 0)} /></Field>
        <Field label="Site name (EN)"><Input name="site_name_en" defaultValue={str("site_name_en", "Tabayyun")} required /></Field>
        <Field label="Site name (UR)"><Input name="site_name_ur" defaultValue={str("site_name_ur", "تبیُّن")} lang="ur" dir="rtl" required /></Field>
        <Field label="Default palette" hint="Until a reader picks one under Display"><Select name="default_theme" defaultValue={themeDefaults.palette} options={THEMES.map(({ id }) => [id, `${en.themes[id]} (${en.themes[`${id}Hint`]})`] as [string, string])} /></Field>
        <Field label="Default reading mode" hint="Wazeh can be the default for everyone; readers can still turn it off"><Select name="default_mode" defaultValue={themeDefaults.mode} options={MODES.map(({ id }) => [id, id === "wazeh" ? `${en.wazeh.name}: ${en.wazeh.description}` : en.display.standard] as [string, string])} /></Field>
        <Field label="Urdu digits"><Select name="digits_ur" defaultValue={str("digits_ur", "latn")} options={[["latn", "Western (1 2 3)"], ["arabext", "Urdu (۱ ۲ ۳)"]]} /></Field>
        <Field label="Disclosure (EN)" className="sm:col-span-3"><Textarea name="disclosure_en" defaultValue={str("disclosure_en")} className="!min-h-16" /></Field>
        <Field label="Disclosure (UR)" className="sm:col-span-3"><Textarea name="disclosure_ur" defaultValue={str("disclosure_ur")} lang="ur" dir="rtl" className="!min-h-16" /></Field>
        <Field label="Notification note" hint="ntfy topic is set in worker/.env; keep a reminder here" className="sm:col-span-3"><Input name="ntfy_note" defaultValue={str("ntfy_note")} /></Field>
        <div className="sm:col-span-3"><Button tone="primary">Save settings</Button></div>
      </form>
      <section id="worker-timer" aria-labelledby="worker-timer-h" className="card mt-6 max-w-3xl p-4">
        <h2 id="worker-timer-h" className="mb-1 font-semibold">Worker schedule</h2>
        <p className="text-sm">
          The worker&apos;s systemd timer checks every 10 minutes and runs the latest slot that is due by the times above, once
          (<code>teenpehr edition --scheduled</code>). A check that finds the slot already run does nothing, so changing these times
          needs no change to the timer. A slot whose run failed or came out empty is not retried on its own: rerun it from{" "}
          <code>worker/</code> with <code>uv run teenpehr edition --date YYYY-MM-DD --slot subh</code>. If the machine was off at a
          slot&apos;s time, the first check after it wakes runs the latest slot due, as a backfill without notifications when it is
          more than 2 hours late.
        </p>
      </section>
    </AdminShell>
  );
}
