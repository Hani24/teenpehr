import "server-only";
import { cache } from "react";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { getEditionFull, type EditionFull } from "./queries";
import { formatDate, picked, type Locale, type Slot } from "./urdu";
import { dateAt } from "./view";

/*
 * The reader's Saved shelf (decision D3 in docs/PLAN.md): stories and whole editions, per account.
 * Only published content can be saved (lib/saved-actions.ts checks on insert), and every read here
 * filters on published again, so nothing unpublished ever reaches a shelf, a download or the
 * offline cache. Writes are in saved-actions.ts; this file only reads.
 */

const { savedStories, savedEditions, stories, editions } = schema;

// Same exclusions as lib/queries.ts: the generated search vectors, the raw feed/post JSON, an image's source_url.
const storyCols = { searchEn: false, searchUr: false } as const;
const itemCols = { search: false, raw: false } as const;
const postCols = { raw: false } as const;
const imageCols = { sourceUrl: false, createdAt: false } as const;

/** Most saved rows a page, a download or the offline manifest will read (newest first). */
export const SHELF_MAX_STORIES = 300;
export const SHELF_MAX_EDITIONS = 40;

export type SavedSets = { stories: Set<number>; editions: Set<number> };

/**
 * What the signed-in reader has saved, as id sets; null when nobody is signed in. One query pair
 * per request however many cards ask (cache()).
 */
export const getSavedSets = cache(async (): Promise<SavedSets | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const [s, e] = await Promise.all([
    db.select({ id: savedStories.storyId }).from(savedStories).where(eq(savedStories.userId, user.id)),
    db.select({ id: savedEditions.editionId }).from(savedEditions).where(eq(savedEditions.userId, user.id)),
  ]);
  return { stories: new Set(s.map((r) => r.id)), editions: new Set(e.map((r) => r.id)) };
});

/** Saved state of one story for the signed-in reader: true/false, or null when signed out (no button). */
export async function storySavedState(storyId: number): Promise<boolean | null> {
  const sets = await getSavedSets();
  return sets ? sets.stories.has(storyId) : null;
}

/** Saved state of one edition for the signed-in reader, as storySavedState. */
export async function editionSavedState(editionId: number): Promise<boolean | null> {
  const sets = await getSavedSets();
  return sets ? sets.editions.has(editionId) : null;
}

/** A saved story with everything a card, the story section of a download and outletsOf() need. */
export async function listSavedStories(userId: number, limit = SHELF_MAX_STORIES) {
  const rows = await db.query.savedStories.findMany({
    where: eq(savedStories.userId, userId),
    orderBy: [desc(savedStories.createdAt), desc(savedStories.storyId)],
    limit,
    with: {
      story: {
        columns: storyCols,
        with: {
          edition: true, group: true, thread: true,
          sources: { with: { item: { columns: itemCols, with: { source: true } } } },
          posts: { with: { post: { columns: postCols } } },
          corrections: { orderBy: (c, { asc }) => [asc(c.createdAt), asc(c.id)] },
          image: { columns: imageCols },
        },
      },
    },
  });
  return rows.filter((r) => r.story.edition.status === "published").map((r) => ({ savedAt: r.createdAt, story: r.story }));
}
export type SavedStory = Awaited<ReturnType<typeof listSavedStories>>[number];

/** Saved editions, newest saved first, with their story count and group leads for a listing. */
export async function listSavedEditions(userId: number, limit = SHELF_MAX_EDITIONS) {
  const rows = await db.select({ savedAt: savedEditions.createdAt, id: editions.id, date: editions.date, slot: editions.slot, publishedAt: editions.publishedAt })
    .from(savedEditions).innerJoin(editions, eq(editions.id, savedEditions.editionId))
    .where(and(eq(savedEditions.userId, userId), eq(editions.status, "published")))
    .orderBy(desc(savedEditions.createdAt), desc(editions.id)).limit(limit);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [counts, leads] = await Promise.all([
    db.select({ editionId: stories.editionId, id: stories.id }).from(stories).where(inArray(stories.editionId, ids)),
    db.query.editionGroups.findMany({ where: (g, { inArray: within }) => within(g.editionId, ids), with: { group: true }, orderBy: (g, { asc }) => [asc(g.order)] }),
  ]);
  const n = new Map<number, number>();
  for (const c of counts) n.set(c.editionId, (n.get(c.editionId) ?? 0) + 1);
  return rows.map((r) => ({
    ...r,
    slot: r.slot as Slot,
    storyCount: n.get(r.id) ?? 0,
    leads: leads.filter((g) => g.editionId === r.id && g.leadEn.trim()),
  }));
}
export type SavedEdition = Awaited<ReturnType<typeof listSavedEditions>>[number];

/** Everything a shelf download holds: each saved edition in full, and each saved story. */
export async function loadShelf(userId: number): Promise<{ editions: Array<{ savedAt: Date; ed: EditionFull }>; stories: SavedStory[] }> {
  const [eds, saved] = await Promise.all([listSavedEditions(userId), listSavedStories(userId)]);
  const full: Array<{ savedAt: Date; ed: EditionFull }> = [];
  // One edition at a time: a shelf is small, and this keeps a download from taking the whole pool.
  for (const e of eds) {
    const ed = await getEditionFull(e.date, e.slot);
    if (ed) full.push({ savedAt: e.savedAt, ed });
  }
  return { editions: full, stories: saved };
}

/* ---- offline manifest ----------------------------------------------------------------------- */

/** Published editions the offline cache always keeps, newest first. */
export const OFFLINE_LATEST_EDITIONS = 3;
/** Upper bound on page URLs one manifest hands the service worker. */
export const OFFLINE_MAX_PAGES = 400;

export type OfflinePageKind = "home" | "saved" | "offline" | "edition" | "story";
export type OfflinePage = {
  url: string;
  kind: OfflinePageKind;
  title: string;
  /** Language of `title` when it is not the manifest's (a story with no Urdu headline yet). */
  lang?: Locale;
  /** Pages whose content changes (home, the shelf): re-fetched on every sync, never trusted from cache. */
  fresh?: boolean;
  /** Saved by the reader itself (a story or an edition). */
  saved?: boolean;
  /** On the shelf, itself or as part of a saved edition: kept even on a data-saving connection. */
  shelf?: boolean;
  date?: string;
  slot?: Slot;
};
export type OfflineManifest = {
  v: 1;
  locale: Locale;
  /**
   * Whose pages these are (the account id). The worker drops everything it kept when a manifest
   * names another account: an invite or reset link signs a new account in on this browser without
   * passing the sign-in page, which is what clears the caches on an ordinary sign-out.
   */
  owner: string;
  generatedAt: string;
  /** Changes whenever the set of pages changes, so a client can skip re-sending an identical list. */
  version: string;
  /** The worker also keeps the scripts, styles and fonts each page names (fonts included: the Urdu faces are in its inline CSS). */
  pages: OfflinePage[];
};

/**
 * URLs of the latest published editions and their stories, plus everything on the reader's shelf,
 * for the service worker to keep (public/sw.js). Paths only, same origin, in the reader's locale.
 */
export async function offlineManifest(userId: number, locale: Locale, labels: { home: string; saved: string; offline: string; edition: (slot: Slot) => string }): Promise<OfflineManifest> {
  const latest = await db.select({ id: editions.id, date: editions.date, slot: editions.slot }).from(editions)
    .where(eq(editions.status, "published")).orderBy(desc(editions.date), desc(editions.slot)).limit(OFFLINE_LATEST_EDITIONS);
  const [savedEds, savedSt] = await Promise.all([
    db.select({ id: editions.id, date: editions.date, slot: editions.slot }).from(savedEditions)
      .innerJoin(editions, eq(editions.id, savedEditions.editionId))
      .where(and(eq(savedEditions.userId, userId), eq(editions.status, "published")))
      .orderBy(desc(savedEditions.createdAt)).limit(SHELF_MAX_EDITIONS),
    db.select({ id: stories.id, titleEn: stories.titleEn, titleUr: stories.titleUr }).from(savedStories)
      .innerJoin(stories, eq(stories.id, savedStories.storyId)).innerJoin(editions, eq(editions.id, stories.editionId))
      .where(and(eq(savedStories.userId, userId), eq(editions.status, "published")))
      .orderBy(desc(savedStories.createdAt)).limit(SHELF_MAX_STORIES),
  ]);
  const edIds = [...new Set([...latest, ...savedEds].map((e) => e.id))];
  const edStories = edIds.length
    ? await db.select({ id: stories.id, editionId: stories.editionId, groupId: stories.groupId, order: stories.order, titleEn: stories.titleEn, titleUr: stories.titleUr })
      .from(stories).where(inArray(stories.editionId, edIds)).orderBy(stories.editionId, stories.groupId, stories.order)
    : [];

  const pages: OfflinePage[] = [];
  const seen = new Set<string>();
  const add = (p: OfflinePage) => {
    if (seen.has(p.url) || pages.length >= OFFLINE_MAX_PAGES) return;
    seen.add(p.url);
    pages.push(p);
  };
  const edTitle = (e: { date: string; slot: string }) => `${labels.edition(e.slot as Slot)} · ${formatDate(dateAt(e.date), locale, { dateStyle: "medium" })}`;
  const savedEdIds = new Set(savedEds.map((e) => e.id));
  const savedStIds = new Set(savedSt.map((s) => s.id));

  // Priority order, since the list is capped: pages that change, the editions, the shelf, then stories.
  add({ url: `/${locale}`, kind: "home", title: labels.home, fresh: true });
  add({ url: `/${locale}/saved`, kind: "saved", title: labels.saved, fresh: true, shelf: true });
  add({ url: `/${locale}/offline`, kind: "offline", title: labels.offline });
  for (const e of [...latest, ...savedEds]) {
    const saved = savedEdIds.has(e.id) || undefined;
    add({ url: `/${locale}/${e.date}/${e.slot}`, kind: "edition", title: edTitle(e), date: e.date, slot: e.slot as Slot, saved, shelf: saved });
  }
  const storyTitle = (s: { titleEn: string; titleUr: string }) => {
    const t = picked(s, "title", locale);
    return { title: t.text, lang: t.lang === locale ? undefined : t.lang };
  };
  for (const s of savedSt) add({ url: `/${locale}/story/${s.id}`, kind: "story", ...storyTitle(s), saved: true, shelf: true });
  // Stories of the editions above, newest edition first (the order `latest` then `savedEds` gave).
  const order = new Map(edIds.map((id, i) => [id, i]));
  for (const s of [...edStories].sort((a, b) => (order.get(a.editionId)! - order.get(b.editionId)!) || a.groupId - b.groupId || a.order - b.order)) {
    add({ url: `/${locale}/story/${s.id}`, kind: "story", ...storyTitle(s), saved: savedStIds.has(s.id) || undefined, shelf: savedStIds.has(s.id) || savedEdIds.has(s.editionId) || undefined });
  }

  const version = hashString(`${locale}|${pages.map((p) => p.url).join(",")}`);
  return { v: 1, locale, owner: String(userId), generatedAt: new Date().toISOString(), version, pages };
}

/** Short stable hash (FNV-1a, 32-bit, base 36): only compares two manifests, never secret. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
