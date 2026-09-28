import { redirect } from "next/navigation";
import type { ZodError, ZodType } from "zod";
import { normalizeUrdu } from "@/lib/urdu";
import { FLASH_SIG_PARAM, signFlash } from "./flash";

export type ActionState = { ok?: string; error?: string; result?: Record<string, unknown> } | null;

/** The worker's edition times while settings has no edition_times row (worker/src/teenpehr/models.py EditionTimes). */
export const SHIPPED_TIMES = { subh: "07:00", dopahar: "13:00", shaam: "19:30" } as const;

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}
export function num(fd: FormData, key: string): number | undefined {
  const s = str(fd, key);
  return s === "" ? undefined : Number(s);
}
export function bool(fd: FormData, key: string): boolean {
  const v = fd.get(key);
  return v === "on" || v === "true" || v === "1";
}
/** Urdu form field, mapped to Urdu code points (ی ک ہ) whichever keyboard layout typed it. */
export function ur(fd: FormData, key: string): string {
  return normalizeUrdu(str(fd, key));
}
/** Comma-separated list; the Urdu comma ، separates too. */
export function list(fd: FormData, key: string): string[] {
  return str(fd, key).split(/[,،]/).map((s) => s.trim()).filter(Boolean);
}
export function all(fd: FormData, key: string): string[] {
  return fd.getAll(key).map(String);
}

/** Parse with zod; on failure redirect back with ?error= so the page shows it. */
export async function parseOrRedirect<T>(schema: ZodType<T>, data: unknown, backTo: string): Promise<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = (r.error as ZodError).issues.slice(0, 5).map((i) => `${i.path.join(".") || "form"}: ${i.message}`).join("; ");
    redirect(await withFlash(backTo, { error: issues }));
  }
  return r.data;
}

/**
 * `path` with a status message for the admin page it lands on. The message is signed for this
 * request's session (lib/admin/flash.ts): pages show only messages the server set for the viewer,
 * never text someone put in a link. Call from a Server Action (it reads the session cookie).
 */
export async function withFlash(path: string, flash: { ok?: string; error?: string }): Promise<string> {
  const u = new URL(path, "http://x");
  if (flash.ok) u.searchParams.set("ok", flash.ok);
  if (flash.error) u.searchParams.set("error", flash.error);
  const sig = flash.ok || flash.error ? await signFlash(flash) : null;
  if (sig) u.searchParams.set(FLASH_SIG_PARAM, sig);
  return u.pathname + u.search + u.hash;
}

/** SQLSTATE and constraint of a failed query; drizzle wraps the driver's PostgresError in `cause`. */
export function pgError(e: unknown): { code?: string; constraint?: string } {
  for (let x = e, depth = 0; x && typeof x === "object" && depth < 3; x = (x as { cause?: unknown }).cause, depth++) {
    const { code, constraint_name } = x as { code?: unknown; constraint_name?: unknown };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return { code, constraint: typeof constraint_name === "string" ? constraint_name : undefined };
  }
  return {};
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }).format(date);
}
export function fmtDuration(a: Date | null, b: Date | null): string {
  if (!a || !b) return "—";
  const s = Math.round((b.getTime() - a.getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
export function fmtMoney(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  return `$${n.toFixed(3)}`;
}
export function ago(d: Date | null | undefined): string {
  if (!d) return "never";
  const h = (Date.now() - d.getTime()) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
