/**
 * One-off data fixes for rows written before a code fix. Idempotent: run it again and it changes
 * nothing. Run after `npm run db:push` / `db:migrate`: npm run db:backfill
 *
 * 1. item_sources: a sighting for each item's first feed (items stored before the table existed), so a
 *    feed that answers 304 can read its items back through GET /api/worker/items.
 * 2. Urdu code points (ی ک ہ) in rows stored before the admin normalised what it saves: glossary, group
 *    names, topic keywords, settings, and the stories and leads of editions that are not published.
 *    Published editions (and their corrections and threads) are immutable and stay exactly as they are.
 * 3. Decisions D1 and D4 (docs/PLAN.md): the shipped site name becomes Tabayyun / تبیُّن, and the stored
 *    theme id "buzurg" becomes "wazeh" (groups.hidden_in_themes, settings.default_theme). Migrated
 *    databases get the same change from db/migrations/0002_wazeh_tabayyun.sql.
 * 4. items.last_seen_at on rows that existed before the column: a push fills it with the time of the
 *    push; it is the latest sighting (max item_sources.last_seen_at), so it is set back to that.
 * 5. Decision D4: a default_theme saved before Settings had a default mode (no default_mode row) never
 *    took effect (the old boot script followed the device), so it becomes "system", and the old
 *    large-type theme becomes the Wazeh mode. Migrated databases: db/migrations/0003_default_palette.sql.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import * as schema from "./schema";
import { normalizeUrdu } from "../lib/urdu";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });
const { items, itemSources, glossary, groups, topics, settings, editions, editionGroups, stories } = schema;

const changed = (a: string, b: string) => a !== b;

async function main() {
  const counts: Record<string, number> = {};

  const sighted = await db.insert(itemSources)
    .select(db.select({ itemId: items.id, sourceId: items.sourceId, firstSeenAt: items.firstSeenAt, lastSeenAt: items.firstSeenAt }).from(items))
    .onConflictDoNothing().returning({ itemId: itemSources.itemId });
  counts.item_sources = sighted.length;

  counts.glossary = 0;
  for (const g of await db.select({ id: glossary.id, termUr: glossary.termUr }).from(glossary)) {
    const ur = normalizeUrdu(g.termUr);
    if (changed(ur, g.termUr)) { await db.update(glossary).set({ termUr: ur }).where(eq(glossary.id, g.id)); counts.glossary++; }
  }
  counts.groups = 0;
  for (const g of await db.select({ id: groups.id, nameUr: groups.nameUr }).from(groups)) {
    const ur = normalizeUrdu(g.nameUr);
    if (changed(ur, g.nameUr)) { await db.update(groups).set({ nameUr: ur }).where(eq(groups.id, g.id)); counts.groups++; }
  }
  counts.topics = 0;
  for (const t of await db.select({ id: topics.id, keywordsUr: topics.keywordsUr }).from(topics)) {
    const ur = t.keywordsUr.map(normalizeUrdu);
    if (ur.some((k, i) => changed(k, t.keywordsUr[i]))) { await db.update(topics).set({ keywordsUr: ur }).where(eq(topics.id, t.id)); counts.topics++; }
  }
  counts.settings = 0;
  for (const s of await db.select().from(settings).where(inArray(settings.key, ["site_name_ur", "disclosure_ur"]))) {
    if (typeof s.value !== "string") continue;
    const ur = normalizeUrdu(s.value);
    if (changed(ur, s.value)) { await db.update(settings).set({ value: ur }).where(eq(settings.key, s.key)); counts.settings++; }
  }

  const open = db.select({ id: editions.id }).from(editions).where(ne(editions.status, "published"));
  counts.stories = 0;
  for (const s of await db.select().from(stories).where(inArray(stories.editionId, open))) {
    const next = {
      titleUr: normalizeUrdu(s.titleUr), summaryUr: normalizeUrdu(s.summaryUr), whyUr: normalizeUrdu(s.whyUr), contestedUr: normalizeUrdu(s.contestedUr),
      angles: s.angles.map((a) => ({ ...a, noteUr: normalizeUrdu(a.noteUr) })),
    };
    const diff = changed(next.titleUr, s.titleUr) || changed(next.summaryUr, s.summaryUr) || changed(next.whyUr, s.whyUr)
      || changed(next.contestedUr, s.contestedUr) || next.angles.some((a, i) => changed(a.noteUr, s.angles[i].noteUr));
    if (diff) { await db.update(stories).set(next).where(eq(stories.id, s.id)); counts.stories++; }
  }
  counts.leads = 0;
  for (const g of await db.select({ id: editionGroups.id, leadUr: editionGroups.leadUr }).from(editionGroups).where(inArray(editionGroups.editionId, open))) {
    const ur = normalizeUrdu(g.leadUr);
    if (changed(ur, g.leadUr)) { await db.update(editionGroups).set({ leadUr: ur }).where(eq(editionGroups.id, g.id)); counts.leads++; }
  }

  // 3. Renames. Only the shipped name is replaced, so a name typed in Settings stays.
  counts.renamed_hidden = (await db.update(groups)
    .set({ hiddenInThemes: sql`array_remove(${groups.hiddenInThemes}, 'buzurg') || case when 'wazeh' = any(${groups.hiddenInThemes}) then '{}'::text[] else '{wazeh}'::text[] end` })
    .where(sql`'buzurg' = any(${groups.hiddenInThemes})`).returning({ id: groups.id })).length;
  const renames: Array<[string, (v: string) => boolean, string]> = [
    ["default_theme", (v) => v === "buzurg", "wazeh"],
    ["site_name_en", (v) => v.trim().toLowerCase() === "teen pehr", "Tabayyun"],
    ["site_name_ur", (v) => normalizeUrdu(v.trim()) === normalizeUrdu("تین پہر"), "تبیُّن"],
  ];
  counts.renamed_settings = 0;
  for (const [key, isOld, value] of renames) {
    const [row] = await db.select().from(settings).where(eq(settings.key, key));
    if (row && typeof row.value === "string" && isOld(row.value)) {
      await db.update(settings).set({ value }).where(and(eq(settings.key, key), eq(settings.value, row.value)));
      counts.renamed_settings++;
    }
  }

  // 4. Only rows ahead of their newest sighting move, so a row the items route keeps in step is never touched.
  const latest = db.select({ itemId: itemSources.itemId, at: sql<Date>`max(${itemSources.lastSeenAt})`.as("at") }).from(itemSources).groupBy(itemSources.itemId).as("latest");
  counts.items_last_seen = (await db.update(items).set({ lastSeenAt: sql`${latest.at}` }).from(latest)
    .where(and(eq(items.id, latest.itemId), sql`${items.lastSeenAt} > ${latest.at}`)).returning({ id: items.id })).length;

  // 5. Once Settings is saved both rows exist, and this changes nothing.
  counts.default_palette = 0;
  const [theme] = await db.select().from(settings).where(eq(settings.key, "default_theme"));
  const [mode] = await db.select().from(settings).where(eq(settings.key, "default_mode"));
  if (theme && !mode) {
    await db.transaction(async (tx) => {
      const large = theme.value === "wazeh" || theme.value === "buzurg";
      await tx.insert(settings).values({ key: "default_mode", value: large ? "wazeh" : "standard" }).onConflictDoNothing();
      await tx.update(settings).set({ value: "system" }).where(eq(settings.key, "default_theme"));
    });
    counts.default_palette = 1;
  }

  console.log("backfill:", JSON.stringify(counts));
}

main().then(() => client.end()).catch(async (e) => { console.error(e); await client.end(); process.exit(1); });
