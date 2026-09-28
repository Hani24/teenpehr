import type { NextRequest } from "next/server";
import { buildFeed, toRss } from "@/lib/feed";
import { feedAccess } from "@/lib/auth/feed-access";

/** RSS for one account's feed reader: /{locale}/feed.xml?token=… (the link on /{locale}/account). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  const denied = await feedAccess(req, locale);
  if (denied) return denied;
  const body = toRss(await buildFeed(locale));
  return new Response(body, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex" } });
}
