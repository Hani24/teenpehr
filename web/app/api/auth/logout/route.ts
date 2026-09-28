import type { NextRequest } from "next/server";
import { destroyAllSessions, destroySession, getCurrentUser } from "@/lib/auth";
import { field, localeOf, methodNotAllowed, readForm, sameOrigin, seeOther } from "../_lib";

/*
 * POST /api/auth/logout (form: locale, everywhere=1 optional). Ends this browser's session, or with
 * `everywhere` every session of the account (this one included), then shows the sign-in page. It also
 * clears this browser's HTTP cache for the site (Clear-Site-Data), so no signed-in page or image stays there.
 */
export async function POST(req: NextRequest) {
  const fd = await readForm(req);
  const locale = localeOf(fd);
  if (!fd || !sameOrigin(req)) return seeOther(`/${locale}/account`, { error: "bad_request" });
  const everywhere = field(fd, "everywhere") === "1";
  const user = everywhere ? await getCurrentUser() : null;
  if (user) await destroyAllSessions(user.id);
  await destroySession();
  const res = seeOther(`/${locale}/login`, { ok: everywhere ? "signed_out_all" : "signed_out" });
  // Images (/media) are cached "private, immutable" for a year; without this their bytes would outlive the
  // session in the browser's HTTP cache, readable by a page the service worker does not control. (The
  // service worker purges its own caches on the sign-in page; browsers act on this only over https or localhost.)
  res.headers.set("Clear-Site-Data", '"cache"');
  return res;
}

export const GET = methodNotAllowed;
