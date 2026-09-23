import "server-only";
import { cache } from "react";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Slot } from "./urdu";

const { editions, editionGroups, stories, groups, threads, settings, glossary } = schema;

export async function getSettings(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(settings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getGroups() {
  return db.select().from(groups).where(eq(groups.active, true)).orderBy(groups.order);
}

/** A full edition with groups, stories, sources and posts. Published only unless `includeDrafts`. */
export async function getEditionFull(date: string, slot: Slot, includeDrafts = false) {
  const ed = await db.query.editions.findFirst({
    where: includeDrafts ? and(eq(editions.date, date), eq(editions.slot, slot)) : and(eq(editions.date, date), eq(editions.slot, slot), eq(editions.status, "published")),
    with: {
      groups: { with: { group: true }, orderBy: (g, { asc }) => [asc(g.order)] },
      stories: {
        orderBy: (s, { asc }) => [asc(s.groupId), asc(s.order)],
        with: {
          thread: true,
          sources: { with: { item: { with: { source: true } } } },
          posts: { with: { post: true } },
          corrections: { orderBy: (c, { asc }) => [asc(c.createdAt)] },
        },
      },
    },
  });
  return ed ?? null;
}
export type EditionFull = NonNullable<Awaited<ReturnType<typeof getEditionFull>>>;
export type StoryFull = EditionFull["stories"][number];

export async function getLatestPublished() {
  const row = await db.select({ date: editions.date, slot: editions.slot }).from(editions)
    .where(eq(editions.status, "published")).orderBy(desc(editions.publishedAt)).limit(1);
  return row[0] ?? null;
}

/** Neighbours for prev/next navigation among published editions. */
export async function getEditionNeighbours(publishedAt: Date) {
  const [prev] = await db.select({ date: editions.date, slot: editions.slot }).from(editions)
    .where(and(eq(editions.status, "published"), lte(editions.publishedAt, new Date(publishedAt.getTime() - 1)))).orderBy(desc(editions.publishedAt)).limit(1);
  const [next] = await db.select({ date: editions.date, slot: editions.slot }).from(editions)
    .where(and(eq(editions.status, "published"), gte(editions.publishedAt, new Date(publishedAt.getTime() + 1)))).orderBy(editions.publishedAt).limit(1);
  return { prev: prev ?? null, next: next ?? null };
}

export async function listPublishedEditions(limit = 90) {
  return db.select({ id: editions.id, date: editions.date, slot: editions.slot, publishedAt: editions.publishedAt }).from(editions)
    .where(eq(editions.status, "published")).orderBy(desc(editions.publishedAt)).limit(limit);
}

/** Lead story per group for an edition listing (archive cards). */
export async function getEditionLeads(editionId: number) {
  return db.select({ groupId: editionGroups.groupId, leadEn: editionGroups.leadEn, leadUr: editionGroups.leadUr, slug: groups.slug, nameEn: groups.nameEn, nameUr: groups.nameUr })
    .from(editionGroups).innerJoin(groups, eq(groups.id, editionGroups.groupId)).where(eq(editionGroups.editionId, editionId)).orderBy(editionGroups.order);
}

export async function getStoryFull(id: number) {
  const s = await db.query.stories.findFirst({
    where: eq(stories.id, id),
    with: {
      edition: true, group: true, thread: true,
      sources: { with: { item: { with: { source: true } } } },
      posts: { with: { post: true } },
      corrections: true,
    },
  });
  if (!s || s.edition.status !== "published") return null;
  return s;
}

/** All published appearances of a thread, newest first. */
export async function getThreadStories(threadId: number) {
  return db.query.stories.findMany({
    where: eq(stories.threadId, threadId),
    with: { edition: true },
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  }).then((rows) => rows.filter((r) => r.edition.status === "published"));
}

export async function getThreadBySlug(slug: string) {
  return db.query.threads.findFirst({ where: eq(threads.slug, slug) });
}

/** Distinct published dates for the archive calendar (YYYY-MM-DD → slots). */
export async function getArchiveIndex() {
  const rows = await db.select({ date: editions.date, slot: editions.slot }).from(editions)
    .where(eq(editions.status, "published")).orderBy(desc(editions.date), sql`array_position(array['subh','dopahar','shaam'], ${editions.slot}::text)`);
  const byDate = new Map<string, Slot[]>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r.slot as Slot]);
  return byDate;
}

/** English term → Urdu term for organisations (outlet names on chips). Deduped per request. */
export const getGlossaryMap = cache(async (): Promise<Map<string, string>> => {
  const rows = await db.select({ en: glossary.termEn, ur: glossary.termUr }).from(glossary).where(eq(glossary.kind, "org"));
  return new Map(rows.map((r) => [r.en.toLowerCase(), r.ur]));
});
