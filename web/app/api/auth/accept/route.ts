import type { NextRequest } from "next/server";
import { z } from "zod";
import { consumeInvite, createSession, destroySession, getSessionToken, PASSWORD_MAX_LENGTH, requestMeta } from "@/lib/auth";
import { normalizeUrdu } from "@/lib/urdu";
import { field, localeOf, methodNotAllowed, readForm, sameOrigin, seeOther } from "../_lib";

/*
 * POST /api/auth/accept (form: kind invite|reset, token, name, password, confirm, locale). Accepts an
 * invite (creates the account) or a reset link (sets a new password and signs the account out
 * everywhere), then signs this browser in. Errors go back to the link's page with ?error=: the link
 * state (invalid, used, expired, user_exists, disabled), a password problem, mismatch or bad_request.
 */
const form = z.object({
  kind: z.enum(["invite", "reset"]),
  token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  name: z.string().max(100),
  password: z.string().max(PASSWORD_MAX_LENGTH * 4),
  confirm: z.string().max(PASSWORD_MAX_LENGTH * 4),
});

export async function POST(req: NextRequest) {
  const fd = await readForm(req);
  const locale = localeOf(fd);
  const parsed = form.safeParse({
    kind: field(fd, "kind"), token: field(fd, "token"), name: normalizeUrdu(field(fd, "name").trim()),
    password: field(fd, "password"), confirm: field(fd, "confirm"),
  });
  if (!parsed.success) return seeOther(`/${locale}/login`, { error: "bad_link" });
  const { kind, token, name, password, confirm } = parsed.data;
  const back = (error: string) => seeOther(`/${locale}/${kind}/${token}`, { error });
  if (!fd || !sameOrigin(req)) return back("bad_request");
  if (password !== confirm) return back("mismatch");

  const result = await consumeInvite(token, { name: kind === "invite" ? name : undefined, password });
  if (!result.ok) return back(result.reason === "weak_password" ? result.problem : result.reason);
  // The link is for this account: whoever was signed in on this browser is signed out first.
  if (await getSessionToken()) await destroySession();
  await createSession(result.user.id, await requestMeta());
  return result.kind === "invite" ? seeOther(`/${locale}`) : seeOther(`/${locale}/account`, { ok: "password_reset" });
}

export const GET = methodNotAllowed;
