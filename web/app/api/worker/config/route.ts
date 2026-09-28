import { NextResponse } from "next/server";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { checkWorkerAuth, noStore } from "@/lib/worker-auth";
import { db, schema } from "@/db";
import { getSettings } from "@/lib/queries";

export async function GET(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const since = new Date(Date.now() - 14 * 86_400_000);
  const [settings, groups, sources, handles, topics, glossary, threads] = await Promise.all([
    getSettings(),
    db.select().from(schema.groups).where(eq(schema.groups.active, true)).orderBy(schema.groups.order),
    db.select().from(schema.sources).where(and(eq(schema.sources.active, true), isNull(schema.sources.archivedAt))).orderBy(schema.sources.id),
    db.select().from(schema.handles).where(eq(schema.handles.active, true)).orderBy(schema.handles.id),
    db.select().from(schema.topics),
    // Locked (editor-approved) spellings first, so they survive any cap the worker puts on the prompt.
    db.select().from(schema.glossary).orderBy(desc(schema.glossary.locked), asc(schema.glossary.termEn)),
    db.select().from(schema.threads).where(gte(schema.threads.lastSeen, since)),
  ]);
  const activeGroupIds = new Set(groups.map((g) => g.id));
  return NextResponse.json({
    settings,
    groups: groups.map((g) => ({ id: g.id, slug: g.slug, name_en: g.nameEn, name_ur: g.nameUr, order: g.order, brief: g.brief, story_count: g.storyCount, x_list_ids: g.xListIds })),
    sources: sources.filter((s) => activeGroupIds.has(s.groupId)).map((s) => ({ id: s.id, group_id: s.groupId, name: s.name, kind: s.kind, url: s.url, lang: s.lang, perspective: s.perspective, fetcher_tier: s.fetcherTier, route: s.route, max_items: s.maxItems, fail_streak: s.failStreak })),
    handles: handles.filter((h) => activeGroupIds.has(h.groupId)).map((h) => ({ id: h.id, group_id: h.groupId, platform: h.platform, handle: h.handle, display_name: h.displayName, role: h.role, last_post_at: h.lastPostAt })),
    topics: topics.map((t) => ({ group_id: t.groupId, keywords_en: t.keywordsEn, keywords_ur: t.keywordsUr, boost: t.boost })),
    glossary: glossary.map((g) => ({ term_en: g.termEn, term_ur: g.termUr, kind: g.kind, locked: g.locked })),
    threads: threads.map((t) => ({ id: t.id, slug: t.slug, title_en: t.titleEn, title_ur: t.titleUr, last_seen: t.lastSeen })),
  }, noStore);
}
