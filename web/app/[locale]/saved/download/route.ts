import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { loadShelf } from "@/lib/saved";
import { renderShelfFile, shelfFileName, wantsImages } from "@/lib/offline-html";

/*
 * The reader's whole Saved shelf as one self-contained HTML file (decision D3): every saved edition
 * in full, then every saved story. Published content only (lib/saved.ts filters). Story images as in
 * the edition download: when the reader's images preference allows, within the file's size budget.
 */
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ locale: z.enum(["en", "ur"]) });

export async function GET(req: Request, ctx: { params: Promise<{ locale: string }> }) {
  const p = paramsSchema.safeParse(await ctx.params);
  if (!p.success) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const { locale } = p.data;
  const user = await requireUser({ locale, next: `/${locale}/saved` });
  const html = await renderShelfFile(await loadShelf(user.id), locale, { images: wantsImages(user.prefs, req) });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${shelfFileName(locale)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
