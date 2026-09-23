import { buildFeed, toRss } from "@/lib/feed";

export const revalidate = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  const body = toRss(await buildFeed(locale));
  return new Response(body, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
