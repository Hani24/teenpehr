import "server-only";
import type { NextRequest } from "next/server";
import { userForFeedToken } from "./feed-token";
import { SESSION_COOKIE, verifySessionToken } from "./session-store";

/*
 * The feeds' own check (the proxy lets /{locale}/feed.* through, decision D2): a feed reader cannot
 * sign in, so it must carry the account's private ?token=. Without a valid one the answer is 401,
 * except for a signed-in browser (someone who clicked a feed link on the site), which is sent to the
 * account page where the private link is made.
 */
export async function feedAccess(req: NextRequest, locale: string): Promise<Response | null> {
  if (await userForFeedToken(req.nextUrl.searchParams.get("token"))) return null;
  const l = locale === "ur" ? "ur" : "en";
  if (await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) {
    return new Response(null, { status: 303, headers: { Location: `/${l}/account#feed`, "Cache-Control": "no-store" } });
  }
  return new Response("This feed is private. Use the feed link from your account page.\n", {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8", "WWW-Authenticate": 'Bearer realm="Tabayyun feed"', "Cache-Control": "no-store" },
  });
}
