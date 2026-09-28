import "server-only";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth/paths";

/*
 * Shared by the sign-in form handlers under /api/auth. They take plain HTML form posts (they work
 * without JavaScript and with curl) and answer with a 303 to a page, carrying ?error= or ?ok= codes
 * the page words in the reader's language. Nothing here trusts the form: every field is parsed with
 * zod, redirects go to same-site paths only, and a post from another site is refused.
 */
export type Locale = "en" | "ur";

const MAX_FORM_BYTES = 16 * 1024;

/**
 * CSRF check for a form post: the browser's Origin (or, failing that, Referer) must be this site.
 * With the session cookie's SameSite=Lax this stops another site from posting on a reader's behalf.
 * Where a strict referrer policy hides both (Origin "null"), the browser's own Sec-Fetch-Site, which
 * no page can set, must say same-origin. A request with none of these is refused.
 */
export function sameOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const from = req.headers.get("origin") ?? req.headers.get("referer");
  if (!from || from === "null") return site === "same-origin";
  let host: string;
  try { host = new URL(from).host; } catch { return false; }
  const own = new Set<string>();
  const h = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (h) own.add(h.split(",")[0].trim());
  own.add(req.nextUrl.host);
  try { if (process.env.SITE_URL) own.add(new URL(process.env.SITE_URL).host); } catch { /* unset or malformed */ }
  return own.has(host);
}

/** The posted form, or null when it is not one, or too large to be one of ours. */
export async function readForm(req: NextRequest): Promise<FormData | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_FORM_BYTES) return null;
  const type = req.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded") && !type.startsWith("multipart/form-data")) return null;
  // Read at most MAX_FORM_BYTES whatever Content-Length says: a chunked body declares no length.
  const body = await readCapped(req.body, MAX_FORM_BYTES);
  if (!body) return null;
  try { return await new Response(body, { headers: { "Content-Type": type } }).formData(); } catch { return null; }
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** A text field, or "" (a file or a missing field). */
export function field(fd: FormData | null, key: string): string {
  const v = fd?.get(key);
  return typeof v === "string" ? v : "";
}

export function localeOf(fd: FormData | null): Locale {
  return field(fd, "locale") === "ur" ? "ur" : "en";
}

/**
 * 303 See Other to a same-site path (with query codes), so the browser follows with a GET. The
 * Location is relative: behind a reverse proxy the request's own host may be an internal one.
 */
export function seeOther(path: string, params: Record<string, string | undefined> = {}, hash = ""): Response {
  const target = safeNextPath(path, "/");
  const [p, q = ""] = target.split("?", 2);
  const sp = new URLSearchParams(q);
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const qs = sp.toString();
  return new Response(null, { status: 303, headers: { Location: `${p}${qs ? `?${qs}` : ""}${hash}`, "Cache-Control": "no-store" } });
}

/** Only POST is served; a GET (a bookmarked form URL) goes to the page instead. */
export function methodNotAllowed(): Response {
  return new Response("Method Not Allowed\n", { status: 405, headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" } });
}

/** Short-lived, httpOnly cookie that carries one value to the page a redirect lands on. */
export async function setFlash(name: string, value: string, path: string, maxAge = 120): Promise<void> {
  (await cookies()).set(name, value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path, maxAge });
}

/** Flash cookie names, read by the pages. */
export const LOGIN_EMAIL_COOKIE = "tb_login_email";
export const FEED_TOKEN_COOKIE = "tb_feed_token";
