import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { imageIn, type ImageIn } from "@/lib/contracts";
import { db, schema } from "@/db";
import type { ImageVariant } from "@/db/schema";
import { IMAGE_MAX_VARIANT_BYTES, IMAGE_MAX_VARIANTS, mediaFileName } from "@/lib/media";
import { storeMediaFile, webpInfo } from "@/lib/media-store";

const { images, items, itemSources, posts } = schema;

/** Two variants at the base64 limit plus room for the rest of the JSON. */
const MAX_BODY_BYTES = IMAGE_MAX_VARIANTS * Math.ceil(IMAGE_MAX_VARIANT_BYTES / 3) * 4 + 64 * 1024;

const bad = (error: string, issues?: unknown) => NextResponse.json({ error, ...(issues ? { issues } : {}) }, { status: 400, ...noStore });

/** The row for this image and owner, if it was uploaded before. */
async function existing(d: ImageIn): Promise<number | null> {
  const owner = d.item_id != null ? eq(images.itemId, d.item_id) : eq(images.postId, d.post_id!);
  const [row] = await db.select({ id: images.id }).from(images).where(and(eq(images.sha256, d.sha256), owner));
  return row?.id ?? null;
}

/**
 * POST /api/worker/images (docs/API.md): one publisher image of a cited item or post, re-encoded by the
 * worker. Every variant must be a still WebP without metadata of exactly its w×h; files land in MEDIA_DIR
 * under content-addressed names, then the row. Idempotent per (sha256, item_id) or (sha256, post_id):
 * a repeat returns the first row unchanged.
 */
export async function POST(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const parsed = await parseBody(req, imageIn, { maxBytes: MAX_BODY_BYTES });
  if ("error" in parsed) return parsed.error;
  const d = parsed.data;

  // Every variant is checked before anything is written.
  const decoded: Array<{ w: number; data: Buffer }> = [];
  for (const [i, v] of d.variants.entries()) {
    const data = Buffer.from(v.data_base64, "base64");
    if (data.length > IMAGE_MAX_VARIANT_BYTES) return bad(`variant over ${IMAGE_MAX_VARIANT_BYTES} bytes`, [{ path: `variants.${i}` }]);
    const info = webpInfo(data);
    if (!info) return bad("variant is not a still WebP without metadata", [{ path: `variants.${i}.data_base64` }]);
    if (info.width !== v.w || info.height !== v.h) {
      return bad("variant bytes do not match its w and h", [{ path: `variants.${i}`, message: `file is ${info.width}×${info.height}` }]);
    }
    decoded.push({ w: v.w, data });
  }

  // The owner must exist; an item's source is a feed that carried it (by default the one that stored it).
  let sourceId: number | null = null;
  if (d.item_id != null) {
    const [item] = await db.select({ id: items.id, sourceId: items.sourceId }).from(items).where(eq(items.id, d.item_id));
    if (!item) return bad("unknown item_id", { items: [d.item_id] });
    sourceId = d.source_id ?? item.sourceId;
    if (sourceId !== item.sourceId) {
      const [seen] = await db.select({ id: itemSources.itemId }).from(itemSources).where(and(eq(itemSources.itemId, item.id), eq(itemSources.sourceId, sourceId)));
      if (!seen) return bad("source_id never carried this item", { sources: [sourceId] });
    }
  } else {
    const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, d.post_id!));
    if (!post) return bad("unknown post_id", { posts: [d.post_id] });
  }

  const before = await existing(d);
  if (before) return NextResponse.json({ image_id: before, created: false }, noStore);

  const variants: ImageVariant[] = [];
  try {
    for (const v of decoded.sort((a, b) => a.w - b.w)) {
      const file = mediaFileName(d.sha256, v.w);
      const stored = await storeMediaFile(file, v.data, v.w);
      variants.push({ w: stored.w, h: stored.h, file, bytes: stored.bytes, mime: "image/webp" });
    }
  } catch (e) {
    console.error("image upload: storing files failed:", (e as Error).message);
    return NextResponse.json({ error: "could not store the image files" }, { status: 500, ...noStore });
  }

  // A concurrent upload of the same image for the same owner may win; then answer with its row.
  const [row] = await db.insert(images).values({
    sha256: d.sha256, sourceUrl: d.source_url, itemId: d.item_id ?? null, postId: d.post_id ?? null, sourceId,
    credit: d.credit, alt: d.alt ?? null, width: d.width, height: d.height, color: d.color, graphic: d.graphic, variants,
  }).onConflictDoNothing().returning({ id: images.id });
  if (row) return NextResponse.json({ image_id: row.id, created: true }, { status: 201, ...noStore });
  const raced = await existing(d);
  if (!raced) return NextResponse.json({ error: "image row could not be written" }, { status: 500, ...noStore });
  return NextResponse.json({ image_id: raced, created: false }, noStore);
}
