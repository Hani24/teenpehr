"use server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";

/*
 * Save and unsave (decision D3). Both actions are idempotent when the client says which state it
 * wants (`save`), so a double tap or a retry never flips twice; without it they toggle. Only a
 * published story or edition can be saved; removing is always allowed. A signed-out caller is sent
 * to sign in (requireUser), then back to `next`.
 */

const { savedStories, savedEditions, stories, editions } = schema;

const idSchema = z.number().int().positive().max(2_147_483_647);
const optsSchema = z.object({
  save: z.boolean().optional(),
  locale: z.enum(["en", "ur"]).optional(),
  // Where to come back to after signing in; loginPath() keeps only same-site paths. Too long (a
  // search page's address) is dropped rather than failing the save.
  next: z.string().max(512).optional().catch(undefined),
}).strict().optional();

export type SaveResult = { ok: true; saved: boolean } | { ok: false; error: "invalid" | "not_found" };
type SaveOpts = z.infer<typeof optsSchema>;

async function parse(id: unknown, opts: unknown) {
  const i = idSchema.safeParse(id);
  const o = optsSchema.safeParse(opts);
  if (!i.success || !o.success) return null;
  const user = await requireUser({ locale: o.data?.locale, next: o.data?.next });
  return { id: i.data, save: o.data?.save, userId: user.id };
}

/** Save (or with save: false, remove) a published story on the signed-in reader's shelf. */
export async function toggleSaveStory(storyId: number, opts?: SaveOpts): Promise<SaveResult> {
  const p = await parse(storyId, opts);
  if (!p) return { ok: false, error: "invalid" };
  const mine = and(eq(savedStories.userId, p.userId), eq(savedStories.storyId, p.id));
  if (p.save === false) {
    await db.delete(savedStories).where(mine);
    return { ok: true, saved: false };
  }
  if (p.save === undefined) {
    const gone = await db.delete(savedStories).where(mine).returning({ id: savedStories.storyId });
    if (gone.length) return { ok: true, saved: false };
  }
  const [s] = await db.select({ id: stories.id }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId))
    .where(and(eq(stories.id, p.id), eq(editions.status, "published")));
  if (!s) return { ok: false, error: "not_found" };
  await db.insert(savedStories).values({ userId: p.userId, storyId: p.id }).onConflictDoNothing();
  return { ok: true, saved: true };
}

/** Save (or with save: false, remove) a whole published edition on the signed-in reader's shelf. */
export async function toggleSaveEdition(editionId: number, opts?: SaveOpts): Promise<SaveResult> {
  const p = await parse(editionId, opts);
  if (!p) return { ok: false, error: "invalid" };
  const mine = and(eq(savedEditions.userId, p.userId), eq(savedEditions.editionId, p.id));
  if (p.save === false) {
    await db.delete(savedEditions).where(mine);
    return { ok: true, saved: false };
  }
  if (p.save === undefined) {
    const gone = await db.delete(savedEditions).where(mine).returning({ id: savedEditions.editionId });
    if (gone.length) return { ok: true, saved: false };
  }
  const [e] = await db.select({ id: editions.id }).from(editions).where(and(eq(editions.id, p.id), eq(editions.status, "published")));
  if (!e) return { ok: false, error: "not_found" };
  await db.insert(savedEditions).values({ userId: p.userId, editionId: p.id }).onConflictDoNothing();
  return { ok: true, saved: true };
}
