import { redirect } from "next/navigation";
import type { ZodError, ZodType } from "zod";

export type ActionState = { ok?: string; error?: string; result?: Record<string, unknown> } | null;

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
export function list(fd: FormData, key: string): string[] {
  return str(fd, key).split(",").map((s) => s.trim()).filter(Boolean);
}
export function all(fd: FormData, key: string): string[] {
  return fd.getAll(key).map(String);
}

/** Parse with zod; on failure redirect back with ?error= so the page shows it. */
export function parseOrRedirect<T>(schema: ZodType<T>, data: unknown, backTo: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = (r.error as ZodError).issues.slice(0, 5).map((i) => `${i.path.join(".") || "form"}: ${i.message}`).join("; ");
    redirect(withFlash(backTo, { error: issues }));
  }
  return r.data;
}

export function withFlash(path: string, flash: { ok?: string; error?: string }): string {
  const u = new URL(path, "http://x");
  if (flash.ok) u.searchParams.set("ok", flash.ok);
  if (flash.error) u.searchParams.set("error", flash.error);
  return u.pathname + u.search;
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
