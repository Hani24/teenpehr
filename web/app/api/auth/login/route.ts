import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, createSession, destroySession, getSessionToken, requestMeta } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth/paths";
import { field, LOGIN_EMAIL_COOKIE, localeOf, methodNotAllowed, readForm, sameOrigin, seeOther, setFlash } from "../_lib";

/*
 * POST /api/auth/login (form: email, password, next, locale). Success: a new session and a 303 to
 * `next` (same-site paths only) or the front page. Failure: back to the sign-in page with one generic
 * code (invalid, rate_limited, disabled, bad_request); the email is carried in a short-lived httpOnly
 * cookie so the form can keep it, never in the URL.
 */
const form = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1000),
});

export async function POST(req: NextRequest) {
  const fd = await readForm(req);
  const locale = localeOf(fd);
  const next = safeNextPath(field(fd, "next"), "");
  const back = (error: string) => seeOther(`/${locale}/login`, { error, next: next || undefined });
  if (!fd || !sameOrigin(req)) return back("bad_request");

  const parsed = form.safeParse({ email: field(fd, "email"), password: field(fd, "password") });
  if (!parsed.success) return back("invalid");
  const { email, password } = parsed.data;
  const meta = await requestMeta();
  const result = await authenticate({ email, password, ip: meta.ip });
  if (!result.ok) {
    await setFlash(LOGIN_EMAIL_COOKIE, email.slice(0, 320), `/${locale}/login`, 300);
    return back(result.reason);
  }
  // A cookie left from someone else's session on this browser is ended, not just replaced.
  if (await getSessionToken()) await destroySession();
  await createSession(result.user.id, meta);
  await setFlash(LOGIN_EMAIL_COOKIE, "", `/${locale}/login`, 0);
  return seeOther(next || `/${locale}`);
}

export const GET = methodNotAllowed;
