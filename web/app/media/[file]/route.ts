import { and, eq, exists, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser, roleAtLeast } from "@/lib/auth";
import { isMediaFileName } from "@/lib/media";
import { openMediaFile } from "@/lib/media-store";

/*
 * GET /media/<sha256>-<w>.webp: a stored image variant (lib/media-store.ts), for signed-in readers only.
 * The proxy walls /media too (a signed-out request gets a 401 there, not the sign-in page); this is the
 * second check. Only names matching MEDIA_FILE_RE are looked up, so nothing else on disk is reachable.
 * Files never change (content-addressed), so a reader's browser may keep them for a year; no shared cache
 * may (private).
 *
 * A reader gets a file only while a published story shows it: a story of a published edition whose image
 * (not hidden by an editor, and of an item or post that story cites) has this file's sha256. So a hidden image
 * stops being served even to someone who kept its URL. Editors and owners get any stored file (the admin shows
 * drafts, and hidden images to the editor who may review them).
 */
const PRIVATE_NO_STORE = "private, no-store";
const { images, stories, editions, storySources, storyPosts } = schema;

/** Whether a published, not-hidden story shows an image with this sha256 (what storyImage() lets a page show). */
async function shownToReaders(sha256: string): Promise<boolean> {
  const cited = or(
    exists(db.select({ one: storySources.itemId }).from(storySources).where(and(eq(storySources.storyId, stories.id), eq(storySources.itemId, images.itemId)))),
    exists(db.select({ one: storyPosts.postId }).from(storyPosts).where(and(eq(storyPosts.storyId, stories.id), eq(storyPosts.postId, images.postId)))),
  );
  const [row] = await db.select({ id: stories.id }).from(images)
    .innerJoin(stories, eq(stories.imageId, images.id))
    .innerJoin(editions, eq(editions.id, stories.editionId))
    .where(and(eq(images.sha256, sha256), isNull(stories.imageHiddenAt), eq(editions.status, "published"), cited))
    .limit(1);
  return !!row;
}

function plain(status: number, text: string) {
  return new Response(`${text}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": PRIVATE_NO_STORE, "X-Content-Type-Options": "nosniff" },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ file: string }> }) {
  const user = await getCurrentUser();
  if (!user) return plain(401, "Sign in required.");
  const { file } = await ctx.params;
  if (!isMediaFileName(file)) return plain(404, "Not found.");
  // Same answer as a missing file: a reader learns nothing about what an editor hid or has not published yet.
  if (!roleAtLeast(user.role, "editor") && !(await shownToReaders(file.slice(0, 64)))) return plain(404, "Not found.");
  const etag = `"${file}"`;
  const found = await openMediaFile(file);
  if (!found) return plain(404, "Not found.");
  const headers = {
    "Content-Type": "image/webp",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Disposition": "inline",
    ETag: etag,
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(found.stream(), { headers: { ...headers, "Content-Length": String(found.size) } });
}
