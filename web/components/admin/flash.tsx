import { FLASH_SIG_PARAM, verifiedFlash } from "@/lib/admin/flash";

export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <div role="status" className={`mb-4 rounded border px-3 py-2 text-sm ${error ? "border-accent bg-surface text-accent" : "border-ok bg-surface text-ok"}`}>
      {error ?? ok}
    </div>
  );
}
/** The page's ?ok= / ?error= message, only when the server signed it for this session (lib/admin/flash.ts). */
export async function flashFrom(searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return verifiedFlash(one(sp.ok), one(sp.error), one(sp[FLASH_SIG_PARAM]));
}
