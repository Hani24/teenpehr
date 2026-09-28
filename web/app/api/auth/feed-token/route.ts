import type { NextRequest } from "next/server";
import { revokeFeedToken, getCurrentUser, rotateFeedToken } from "@/lib/auth";
import { FEED_TOKEN_COOKIE, field, localeOf, methodNotAllowed, readForm, sameOrigin, seeOther, setFlash } from "../_lib";

/*
 * POST /api/auth/feed-token (form: action rotate|revoke, locale). Makes a new private feed token (the
 * old one stops working) or switches it off. The new token is handed to the account page once, in a
 * two-minute httpOnly cookie scoped to that page; only its sha256 is stored.
 */
export async function POST(req: NextRequest) {
  const fd = await readForm(req);
  const locale = localeOf(fd);
  const back = (params: Record<string, string>) => seeOther(`/${locale}/account`, params, "#feed");
  const user = await getCurrentUser();
  if (!user) return seeOther(`/${locale}/login`, { next: `/${locale}/account` });
  if (!fd || !sameOrigin(req)) return back({ error: "bad_request" });

  const action = field(fd, "action");
  if (action === "revoke") {
    await revokeFeedToken(user.id);
    return back({ ok: "feed_revoked" });
  }
  if (action !== "rotate") return back({ error: "bad_request" });
  const token = await rotateFeedToken(user.id);
  await setFlash(FEED_TOKEN_COOKIE, token, `/${locale}/account`, 120);
  return back({ ok: "feed_new" });
}

export const GET = methodNotAllowed;
