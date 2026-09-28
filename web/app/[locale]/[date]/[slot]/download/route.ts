import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getEditionFull } from "@/lib/queries";
import { editionFileName, isEditionDate, renderEditionFile, wantsImages } from "@/lib/offline-html";
import { SLOTS } from "@/lib/urdu";

/*
 * One published edition as a single self-contained HTML file (decision D3), as an attachment named
 * tabayyun-<date>-<slot>-<locale>.html. Signed-in readers only; a signed-out click goes to sign in
 * and comes back to the edition page, not to a bare file. Story images are embedded when the reader's
 * images preference allows (wantsImages), within the file's size budget (lib/offline-html.ts).
 */
export const dynamic = "force-dynamic";

const isoDate = z.string().refine(isEditionDate);
const paramsSchema = z.object({ locale: z.enum(["en", "ur"]), date: isoDate, slot: z.enum(SLOTS) });

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" } });

export async function GET(req: Request, ctx: { params: Promise<{ locale: string; date: string; slot: string }> }) {
  const p = paramsSchema.safeParse(await ctx.params);
  if (!p.success) return plain(404, "Not found");
  const { locale, date, slot } = p.data;
  const user = await requireUser({ locale, next: `/${locale}/${date}/${slot}` });
  const ed = await getEditionFull(date, slot);
  if (!ed) return plain(404, "Not found");
  const html = await renderEditionFile(ed, locale, { images: wantsImages(user.prefs, req) });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${editionFileName(date, slot, locale)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
