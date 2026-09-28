import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser, loginPath } from "./index";
import { isAuthPage, PATH_HEADER, safeNextPath } from "./paths";
import type { SessionUser } from "./session-store";

/**
 * The reader pages' own check, behind the proxy's (web/proxy.ts): the signed-in user, or a redirect
 * to sign in. The sign-in, invite and reset pages share the [locale] layout, so they are let through
 * signed out (null) when the proxy marked the request as one of them. The proxy replaces whatever
 * value the client sent, so a request it never saw (a matcher gap) is still sent to sign in; only a
 * client that also forges the header gets past this layer, which is why account data, admin pages,
 * actions and routes check the user themselves.
 */
export async function gateReader(locale: "en" | "ur"): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  if (user) return user;
  const path = (await headers()).get(PATH_HEADER) ?? "";
  if (isAuthPage(path)) return null;
  redirect(loginPath(locale, safeNextPath(path, "")));
}
