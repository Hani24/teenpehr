import type { NextRequest } from "next/server";
import { buildFeed, toJsonFeed } from "@/lib/feed";
import { feedAccess } from "@/lib/auth/feed-access";

/** JSON Feed for one account's feed reader: /{locale}/feed.json?token=… (the link on /{locale}/account). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  const denied = await feedAccess(req, locale);
  if (denied) return denied;
  return Response.json(toJsonFeed(await buildFeed(locale)), { headers: { "Content-Type": "application/feed+json; charset=utf-8", "Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex" } });
}
