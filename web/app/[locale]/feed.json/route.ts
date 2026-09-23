import { buildFeed, toJsonFeed } from "@/lib/feed";

export const revalidate = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  return Response.json(toJsonFeed(await buildFeed(locale)), { headers: { "Content-Type": "application/feed+json; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
