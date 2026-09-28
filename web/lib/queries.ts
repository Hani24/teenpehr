import "server-only";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { storedPrefs } from "@/lib/auth/prefs";
import { themeDef, BASE_THEME } from "./view";
import { SLOTS, type Slot, type UrduDigits } from "./urdu";

const { editions, editionGroups, stories, groups, threads, settings, glossary } = schema;

/*
 * Published data is cached across requests (every reader page renders per reader since the login
 * wall, D2, so without this each request would run every edition query). Two tags: EDITIONS_TAG for
 * editions, stories, groups, sources and the glossary; SETTINGS_TAG for the settings table.
 * lib/admin/publish.ts expires EDITIONS_TAG when an edition is published, and every admin action that
 * changes what readers see expires the tag it touches. CACHE_SECONDS is only the safety net for
 * changes made outside the app (psql, db/backfill.ts). Drafts and the admin read the database directly.
 */
export const EDITIONS_TAG = "editions";
export const SETTINGS_TAG = "settings";
const CACHE_SECONDS = 600;

// unstable_cache keeps JSON, which would turn every Date into a string: Dates are tagged on the way
// in and revived on the way out, so a cached result has exactly the types of an uncached one.
const DATE_KEY = "__tb_date";
function pack(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
    const raw = this[key]; // before Date#toJSON ran
    return raw instanceof Date ? { [DATE_KEY]: raw.toISOString() } : v;
  });
}
function unpack<T>(text: string): T {
  return JSON.parse(text, (_key, v) => (v && typeof v === "object" && typeof v[DATE_KEY] === "string" && Object.keys(v).length === 1 ? new Date(v[DATE_KEY]) : v));
}
/** `load` cached under `key` and `tags` (arguments are part of the key), and deduplicated per request. */
function cached<A extends unknown[], R>(key: string, tags: string[], load: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  const stored = unstable_cache(async (...args: A) => pack(await load(...args)), [key], { tags, revalidate: CACHE_SECONDS });
  return cache(async (...args: A) => unpack<R>(await stored(...args)));
}

/*
 * Columns pages never render, left out of the relational loads below: the generated search vectors
 * (as large as the text they index) and the raw feed/post JSON kept for research. Queries that need
 * them select them explicitly.
 */
const storyCols = { searchEn: false, searchUr: false } as const;
const itemCols = { search: false, raw: false } as const;
const postCols = { raw: false } as const;
// Where the worker downloaded an image is never shown or linked to readers (lib/media.ts StoryImage).
const imageCols = { sourceUrl: false, createdAt: false } as const;

/** Every settings row, read now (the admin, the worker's config, publishing). */
export async function getSettings(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(settings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
/** The same, cached for reader pages (SETTINGS_TAG). */
export const getCachedSettings = cached("settings", [SETTINGS_TAG], getSettings);

/**
 * The admin settings the reader pages render with (Settings screen), deduped per request. `digitsUr`
 * is the signed-in reader's own choice of Urdu digits when they made one (display preferences, D4),
 * else the site's; pass it to formatDate/localDigits.
 */
export type SitePrefs = {
  digitsUr: UrduDigits;
  disclosureEn: string;
  disclosureUr: string;
  defaultTheme: string;
  editorName: string;
  hijriAdjust: number;
};
export const getSitePrefs = cache(async (): Promise<SitePrefs> => {
  const [s, user] = await Promise.all([getCachedSettings(), getCurrentUser()]);
  const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string).trim() : "");
  return {
    digitsUr: storedPrefs(user?.prefs).digits ?? (s.digits_ur === "arabext" ? "arabext" : "latn"),
    disclosureEn: str("disclosure_en"),
    disclosureUr: str("disclosure_ur"),
    defaultTheme: themeDef(str("default_theme"))?.id ?? BASE_THEME,
    editorName: str("editor_name"),
    hijriAdjust: Number.isFinite(Number(s.hijri_adjust)) ? Number(s.hijri_adjust) : 0,
  };
});

export const getGroups = cached("groups", [EDITIONS_TAG], async () =>
  db.select().from(groups).where(eq(groups.active, true)).orderBy(groups.order));

/**
 * A full edition with groups, stories, sources, posts and each story's image (null when it has none; an
 * editor-hidden one is still here with stories.image_hidden_at set: show it through lib/media.ts
 * storyImage()), read now. Published only unless `includeDrafts`. This is also the published snapshot.
 */
async function loadEdition(date: string, slot: Slot, includeDrafts: boolean) {
  const ed = await db.query.editions.findFirst({
    where: includeDrafts ? and(eq(editions.date, date), eq(editions.slot, slot)) : and(eq(editions.date, date), eq(editions.slot, slot), eq(editions.status, "published")),
    with: {
      groups: { with: { group: true }, orderBy: (g, { asc }) => [asc(g.order)] },
      stories: {
        columns: storyCols,
        orderBy: (s, { asc }) => [asc(s.groupId), asc(s.order)],
        with: {
          thread: true,
          sources: { with: { item: { columns: itemCols, with: { source: true } } } },
          posts: { with: { post: { columns: postCols } } },
          corrections: { orderBy: (c, { asc }) => [asc(c.createdAt)] },
          image: { columns: imageCols },
        },
      },
    },
  });
  return ed ?? null;
}
const publishedEdition = cached("edition-full", [EDITIONS_TAG], (date: string, slot: Slot) => loadEdition(date, slot, false));
/** A full edition: published ones from the cache; with `includeDrafts` (the admin), whatever is stored now. */
export async function getEditionFull(date: string, slot: Slot, includeDrafts = false) {
  return includeDrafts ? loadEdition(date, slot, true) : publishedEdition(date, slot);
}
export type EditionFull = NonNullable<Awaited<ReturnType<typeof loadEdition>>>;
export type StoryFull = EditionFull["stories"][number];

/*
 * Editions are ordered by (date, slot), never by published_at: an edition held for review can be
 * published after the next slot's, and it is still the earlier edition. The edition_slot enum is
 * declared subh, dopahar, shaam, so Postgres sorts and compares it in that order.
 */
const editionKey = (date: string, slot: Slot) => sql`(${date}::date, ${slot}::edition_slot)`;

export const getLatestPublished = cached("latest", [EDITIONS_TAG], async () => {
  const row = await db.select({ date: editions.date, slot: editions.slot }).from(editions)
    .where(eq(editions.status, "published")).orderBy(desc(editions.date), desc(editions.slot)).limit(1);
  return row[0] ?? null;
});

/** Neighbours for prev/next navigation among published editions. */
export const getEditionNeighbours = cached("neighbours", [EDITIONS_TAG], async (date: string, slot: Slot) => {
  const [prev] = await db.select({ date: editions.date, slot: editions.slot }).from(editions)
    .where(and(eq(editions.status, "published"), sql`(${editions.date}, ${editions.slot}) < ${editionKey(date, slot)}`))
    .orderBy(desc(editions.date), desc(editions.slot)).limit(1);
  const [next] = await db.select({ date: editions.date, slot: editions.slot }).from(editions)
    .where(and(eq(editions.status, "published"), sql`(${editions.date}, ${editions.slot}) > ${editionKey(date, slot)}`))
    .orderBy(asc(editions.date), asc(editions.slot)).limit(1);
  return { prev: prev ?? null, next: next ?? null };
});

export const listPublishedEditions = cached("published-list", [EDITIONS_TAG], async (limit: number = 90) =>
  db.select({ id: editions.id, date: editions.date, slot: editions.slot, publishedAt: editions.publishedAt }).from(editions)
    .where(eq(editions.status, "published")).orderBy(desc(editions.date), desc(editions.slot)).limit(limit));


/** Lead story per group for an edition listing (archive cards). */
export async function getEditionLeads(editionId: number) {
  return db.select({ groupId: editionGroups.groupId, leadEn: editionGroups.leadEn, leadUr: editionGroups.leadUr, slug: groups.slug, nameEn: groups.nameEn, nameUr: groups.nameUr })
    .from(editionGroups).innerJoin(groups, eq(groups.id, editionGroups.groupId)).where(eq(editionGroups.editionId, editionId)).orderBy(editionGroups.order);
}

export const getStoryFull = cached("story-full", [EDITIONS_TAG], async (id: number) => {
  const s = await db.query.stories.findFirst({
    where: eq(stories.id, id),
    columns: storyCols,
    with: {
      edition: true, group: true, thread: true,
      sources: { with: { item: { columns: itemCols, with: { source: true } } } },
      posts: { with: { post: { columns: postCols } } },
      corrections: { orderBy: (c, { asc }) => [asc(c.createdAt), asc(c.id)] },
      image: { columns: imageCols },
    },
  });
  if (!s || s.edition.status !== "published") return null;
  return s;
});

/** All published appearances of a thread, newest edition first. */
export const getThreadStories = cached("thread-stories", [EDITIONS_TAG], async (threadId: number) => {
  const rows = await db.query.stories.findMany({ where: eq(stories.threadId, threadId), columns: storyCols, with: { edition: true } });
  return rows.filter((r) => r.edition.status === "published")
    .sort((a, b) => b.edition.date.localeCompare(a.edition.date) || SLOTS.indexOf(b.edition.slot) - SLOTS.indexOf(a.edition.slot));
});

export async function getThreadBySlug(slug: string) {
  return db.query.threads.findFirst({ where: eq(threads.slug, slug) });
}

const archiveRows = cached("archive", [EDITIONS_TAG], async () =>
  db.select({ date: editions.date, slot: editions.slot }).from(editions)
    .where(eq(editions.status, "published")).orderBy(desc(editions.date), sql`array_position(array['subh','dopahar','shaam'], ${editions.slot}::text)`));
/** Distinct published dates for the archive calendar (YYYY-MM-DD → slots). */
export async function getArchiveIndex() {
  const byDate = new Map<string, Slot[]>();
  for (const r of await archiveRows()) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r.slot as Slot]);
  return byDate;
}

const glossaryOrgs = cached("glossary-orgs", [EDITIONS_TAG], async () =>
  db.select({ en: glossary.termEn, ur: glossary.termUr }).from(glossary).where(eq(glossary.kind, "org")));
/** English term → Urdu term for organisations (outlet names on chips). Deduped per request. */
export const getGlossaryMap = cache(async (): Promise<Map<string, string>> =>
  new Map((await glossaryOrgs()).map((r) => [r.en.toLowerCase(), r.ur])));
