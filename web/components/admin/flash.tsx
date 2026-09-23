export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <div role="status" className={`mb-4 rounded border px-3 py-2 text-sm ${error ? "border-accent bg-surface text-accent" : "border-ok bg-surface text-ok"}`}>
      {error ?? ok}
    </div>
  );
}
export async function flashFrom(searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return { ok: one(sp.ok), error: one(sp.error) };
}
