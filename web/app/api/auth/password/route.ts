import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, createSession, destroySession, getCurrentUser, PASSWORD_MAX_LENGTH, requestMeta, setPassword } from "@/lib/auth";
import { field, localeOf, methodNotAllowed, readForm, sameOrigin, seeOther } from "../_lib";

/*
 * POST /api/auth/password (form: current, password, confirm, locale). The signed-in reader's own
 * password change. The current password is checked through the sign-in rate limit, so a borrowed
 * unlocked browser cannot guess it; on success every other session ends and this one gets a new token.
 */
const form = z.object({
  current: z.string().min(1).max(1000),
  password: z.string().max(PASSWORD_MAX_LENGTH * 4),
  confirm: z.string().max(PASSWORD_MAX_LENGTH * 4),
});

export async function POST(req: NextRequest) {
  const fd = await readForm(req);
  const locale = localeOf(fd);
  const back = (params: Record<string, string>) => seeOther(`/${locale}/account`, params, "#password");
  const user = await getCurrentUser();
  if (!user) return seeOther(`/${locale}/login`, { next: `/${locale}/account` });
  if (!fd || !sameOrigin(req)) return back({ error: "bad_request" });

  const parsed = form.safeParse({ current: field(fd, "current"), password: field(fd, "password"), confirm: field(fd, "confirm") });
  if (!parsed.success) return back({ error: "current_wrong" });
  const { current, password, confirm } = parsed.data;
  if (password !== confirm) return back({ error: "mismatch" });

  const meta = await requestMeta();
  const check = await authenticate({ email: user.email, password: current, ip: meta.ip });
  if (!check.ok) return back({ error: check.reason === "rate_limited" ? "rate_limited" : "current_wrong" });
  const problem = await setPassword(user.id, password);
  if (problem) return back({ error: problem });
  // A fresh token for this browser too: whatever knew the old cookie is now signed out.
  await destroySession();
  await createSession(user.id, meta);
  return back({ ok: "password" });
}

export const GET = methodNotAllowed;
