import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, exists, inArray, isNull, or } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { isMediaFileName, mediaUrl, sortedVariants } from "@/lib/media";
import { wantsImages } from "@/lib/offline-html";
import { offlineManifest, OFFLINE_MAX_PAGES, type OfflineManifest, type OfflinePage } from "@/lib/saved";
import { getDeskStories } from "@/lib/queries";
import { storyVisibleSql } from "@/lib/desk";
import { storyRev } from "@/lib/review-state";
import { picked, type Locale, type Slot } from "@/lib/urdu";

/*
 * GET /api/offline/manifest?locale=en|ur: the pages the service worker keeps for offline reading
 * (public/sw.js): the latest published editions and their stories, and the signed-in reader's
 * Saved shelf. Signed-in readers only; this is an API, so a signed-out call gets 401, not a
 * redirect. Never cached, by the browser or by the service worker (which leaves /api/* alone).
 *
 * `media`: the 480 px image of each of those stories that shows one (D6), in the pages' order, so the
 * pictures open offline too. Empty when the reader's images preference is "off", or "auto" and the request
 * says Save-Data: on (lib/offline-html.ts wantsImages: the device's choice from ?images=, else the account's);
 * the worker also skips it on a data-saving connection.
 */
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "private, no-store" } };
const querySchema = z.object({ locale: z.enum(["en", "ur"]).default("en") });
/** As many as the worker keeps (public/sw.js MEDIA_MAX). */
const MEDIA_MAX = 200;
const STORY_PATH = /^\/(?:en|ur)\/story\/(\d{1,10})$/;

const { stories, images, editions, storySources, storyPosts } = schema;

/**
 * /media URLs of the stories' images (narrowest variant), in the given order; published, not hidden, and
 * only an image of an item or post the story cites (I1: what the pages show, lib/media.ts storyImage).
 */
async function mediaFor(storyIds: number[]): Promise<string[]> {
  if (!storyIds.length) return [];
  const cited = or(
    exists(db.select({ one: storySources.itemId }).from(storySources).where(and(eq(storySources.storyId, stories.id), eq(storySources.itemId, images.itemId)))),
    exists(db.select({ one: storyPosts.postId }).from(storyPosts).where(and(eq(storyPosts.storyId, stories.id), eq(storyPosts.postId, images.postId)))),
  );
  const rows = await db.select({ id: stories.id, variants: images.variants }).from(stories)
    .innerJoin(images, eq(images.id, stories.imageId))
    .innerJoin(editions, eq(editions.id, stories.editionId))
    .where(and(inArray(stories.id, storyIds), isNull(stories.imageHiddenAt), storyVisibleSql, cited)); // published, or live on the Editor's desk
  const byStory = new Map(rows.map((r) => [r.id, r.variants]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of storyIds) {
    const variants = byStory.get(id);
    const file = Array.isArray(variants) && variants.length ? sortedVariants({ variants })[0].file : null;
    if (!file || !isMediaFileName(file)) continue;
    const url = mediaUrl(file);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MEDIA_MAX) break;
  }
  return out;
}

/** Put the desk stories' pages into `manifest` after its editions (in place, within the page cap); their ids. */
async function addDeskPages(manifest: OfflineManifest, locale: Locale): Promise<number[]> {
  const desk = await getDeskStories();
  const known = new Set(manifest.pages.map((p) => p.url));
  const room = Math.max(0, OFFLINE_MAX_PAGES - manifest.pages.length);
  const pages: OfflinePage[] = desk.map((s): OfflinePage => {
    const t = picked(s, "title", locale);
    return { url: `/${locale}/story/${s.id}`, kind: "story", title: t.text, ...(t.lang === locale ? {} : { lang: t.lang }), rev: storyRev(s) };
  }).filter((p) => !known.has(p.url)).slice(0, room);
  if (!pages.length) return [];
  let at = 0;
  manifest.pages.forEach((p, i) => { if (p.kind !== "story") at = i + 1; });
  manifest.pages.splice(at, 0, ...pages);
  return pages.map((p) => Number(STORY_PATH.exec(p.url)?.[1]));
}

export async function GET(req: Request) {
  const q = querySchema.safeParse({ locale: new URL(req.url).searchParams.get("locale") ?? undefined });
  if (!q.success) return NextResponse.json({ error: "invalid", issues: q.error.issues }, { status: 400, ...noStore });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401, ...noStore });
  const { locale } = q.data;
  const [ts, tn, to, ta] = await Promise.all([
    getTranslations({ locale, namespace: "slots" }), getTranslations({ locale, namespace: "nav" }),
    getTranslations({ locale, namespace: "offline" }), getTranslations({ locale, namespace: "saved" }),
  ]);
  const manifest = await offlineManifest(user.id, locale, {
    home: tn("today"),
    saved: ta("title"),
    offline: to("title"),
    edition: (slot: Slot) => ts(`${slot}Long`),
  });
  // The Editor's desk (D12): the kept front page links to these stories before their edition is published,
  // so they are kept too, right after the editions (the list is capped).
  const deskIds = await addDeskPages(manifest, locale);
  const storyIds = manifest.pages.filter((p) => p.kind === "story").map((p) => Number(STORY_PATH.exec(p.url)?.[1])).filter((n) => Number.isSafeInteger(n) && n > 0);
  const media = wantsImages(user.prefs, req) ? await mediaFor(storyIds) : [];
  const deskTag = deskIds.length ? `.d${deskIds.join("_")}` : "";
  const body: OfflineManifest & { media: string[] } = { ...manifest, version: `${manifest.version}${deskTag}.${media.length}`, media };
  return NextResponse.json(body, noStore);
}
