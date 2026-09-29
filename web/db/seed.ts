/**
 * Seed groups, sources, handles, glossary and settings from db/seed/*.json.
 * Idempotent: upserts by natural keys, never deletes. Run: npm run db:seed
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, inArray } from "drizzle-orm";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const dir = join(process.cwd(), "db", "seed");
const load = <T>(name: string): T | null => existsSync(join(dir, name)) ? (JSON.parse(readFileSync(join(dir, name), "utf8")) as T) : null;

type GroupSeed = { slug: string; name_en: string; name_ur: string; order: number; brief: string; story_count: number };
type SourceSeed = {
  group: string; name: string; kind: "rss" | "gnews" | "youtube" | "html" | "telegram" | "sitemap" | "gdelt"; url: string; lang: string;
  perspective?: string; route?: "direct" | "germany"; max_items?: number; active?: boolean; notes?: string;
  previous_urls?: string[]; check?: { status?: string };
};
type HandleSeed = { group: string; platform: "x" | "bluesky" | "telegram" | "youtube"; handle: string; display_name?: string; role?: "outlet" | "journalist" | "official" | "analyst"; active?: boolean };
type GlossarySeed = { term_en: string; term_ur: string; kind?: "person" | "place" | "org" | "other" };

async function main() {
  const counts: Record<string, number> = {};
  const groupsSeed = load<GroupSeed[]>("groups.json") ?? [];
  for (const g of groupsSeed) {
    await db.insert(schema.groups).values({ slug: g.slug, nameEn: g.name_en, nameUr: g.name_ur, order: g.order, brief: g.brief, storyCount: g.story_count })
      .onConflictDoUpdate({ target: schema.groups.slug, set: { nameEn: g.name_en, nameUr: g.name_ur, order: g.order, brief: g.brief, storyCount: g.story_count } });
  }
  counts.groups = groupsSeed.length;
  const groupIds = new Map((await db.select({ id: schema.groups.id, slug: schema.groups.slug }).from(schema.groups)).map((r) => [r.slug, r.id]));

  const sourcesSeed = load<SourceSeed[]>("sources.json") ?? [];
  let skipped = 0;
  for (const s of sourcesSeed) {
    const groupId = groupIds.get(s.group);
    if (!groupId) { skipped++; console.warn(`source ${s.name}: unknown group ${s.group}`); continue; }
    // D11: a seed row is switched on only when its recorded live check passed (the same rule as
    // `npm run sources:apply`, which remains the way to change `active` on an existing database).
    const active = (s.active ?? true) && (!s.check || s.check.status === "ok");
    const row = { groupId, name: s.name, kind: s.kind, url: s.url, lang: s.lang, perspective: s.perspective ?? "", route: s.route ?? "direct", maxItems: s.max_items ?? 8, active, notes: s.notes ?? "" };
    // A feed that moved (previous_urls) updates its old row instead of adding a second one.
    const urls = [s.url, ...(s.previous_urls ?? [])];
    const found = await db.select({ id: schema.sources.id, url: schema.sources.url }).from(schema.sources).where(and(eq(schema.sources.groupId, groupId), inArray(schema.sources.url, urls)));
    const existing = found.find((r) => r.url === s.url) ?? found[0]; // the current URL's row wins (unique per group)
    if (existing) await db.update(schema.sources).set({ name: row.name, kind: row.kind, url: row.url, lang: row.lang, perspective: row.perspective, route: row.route, maxItems: row.maxItems, notes: row.notes }).where(eq(schema.sources.id, existing.id));
    else await db.insert(schema.sources).values(row);
  }
  counts.sources = sourcesSeed.length - skipped;

  const handlesSeed = load<HandleSeed[]>("handles.json") ?? [];
  for (const h of handlesSeed) {
    const groupId = groupIds.get(h.group);
    if (!groupId) { console.warn(`handle ${h.handle}: unknown group ${h.group}`); continue; }
    await db.insert(schema.handles).values({ groupId, platform: h.platform, handle: h.handle.replace(/^@/, ""), displayName: h.display_name ?? "", role: h.role ?? "journalist", active: h.active ?? true })
      .onConflictDoUpdate({ target: [schema.handles.platform, schema.handles.handle], set: { groupId, displayName: h.display_name ?? "", role: h.role ?? "journalist" } });
  }
  counts.handles = handlesSeed.length;

  const glossarySeed = load<GlossarySeed[]>("glossary.json") ?? [];
  for (const g of glossarySeed) {
    await db.insert(schema.glossary).values({ termEn: g.term_en, termUr: g.term_ur, kind: g.kind ?? "other", locked: true }).onConflictDoNothing();
  }
  counts.glossary = glossarySeed.length;

  const settingsSeed = load<Record<string, unknown>>("settings.json") ?? {};
  for (const [key, value] of Object.entries(settingsSeed)) {
    await db.insert(schema.settings).values({ key, value }).onConflictDoNothing(); // never overwrite admin edits
  }
  counts.settings = Object.keys(settingsSeed).length;
  console.log("seeded", counts);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
