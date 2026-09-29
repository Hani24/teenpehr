import "server-only";
import { and, desc, eq, gte, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getEditionFull } from "@/lib/queries";
import { normalizeUrdu, type Slot } from "@/lib/urdu";

const { groups, sources, handles, topics, glossary, editions, editionGroups, runs, runSources, stories, items, storySources, storyReports, workerJobs } = schema;

export async function dashboard() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  const [todaysEditions, recentRuns, srcStats, edCount, openReports, jobStats] = await Promise.all([
    db.select().from(editions).where(eq(editions.date, today)),
    db.select().from(runs).orderBy(desc(runs.startedAt)).limit(10),
    db.select({ active: sql<number>`count(*) filter (where ${sources.active})`, failing: sql<number>`count(*) filter (where ${sources.active} and ${sources.failStreak} >= 3)`, total: sql<number>`count(*)` }).from(sources).where(isNull(sources.archivedAt)),
    db.select({ n: sql<number>`count(*)` }).from(editions).where(eq(editions.status, "published")),
    // D8 reports waiting for an editor, and D9/D12 jobs waiting for (or stuck in) the worker.
    db.select({ n: sql<number>`count(*)` }).from(storyReports).where(eq(storyReports.status, "open")),
    db.select({
      queued: sql<number>`count(*) filter (where ${workerJobs.status} = 'queued')`,
      running: sql<number>`count(*) filter (where ${workerJobs.status} = 'running')`,
      failedToday: sql<number>`count(*) filter (where ${workerJobs.status} = 'failed' and ${workerJobs.updatedAt} > now() - interval '1 day')`,
    }).from(workerJobs),
  ]);
  const itemsByRun = new Map<number, number>();
  if (recentRuns.length) {
    const rows = await db.select({ runId: runSources.runId, n: sql<number>`sum(${runSources.items})` }).from(runSources).groupBy(runSources.runId);
    rows.forEach((r) => itemsByRun.set(r.runId, Number(r.n)));
  }
  return { today, todaysEditions, recentRuns: recentRuns.map((r) => ({ ...r, items: itemsByRun.get(r.id) ?? 0 })), srcStats: srcStats[0], published: Number(edCount[0].n),
    openReports: Number(openReports[0].n), jobs: { queued: Number(jobStats[0].queued), running: Number(jobStats[0].running), failedToday: Number(jobStats[0].failedToday) } };
}

export async function listGroups() {
  return db.select().from(groups).orderBy(groups.order, groups.id);
}
export async function getGroup(id: number) {
  const [g] = await db.select().from(groups).where(eq(groups.id, id));
  if (!g) return null;
  const groupTopics = await db.select().from(topics).where(eq(topics.groupId, id));
  return { ...g, topics: groupTopics };
}

export type SourceFilter = { group?: string; kind?: string; route?: string; active?: string; q?: string };
/** Live (non-archived) sources; archived ones are listed separately by listArchivedSources. */
export async function listSources(f: SourceFilter) {
  const conds = [isNull(sources.archivedAt)];
  if (f.group) conds.push(eq(groups.slug, f.group));
  if (f.kind) conds.push(eq(sources.kind, f.kind as typeof sources.kind.enumValues[number]));
  if (f.route) conds.push(eq(sources.route, f.route as typeof sources.route.enumValues[number]));
  if (f.active === "1") conds.push(eq(sources.active, true));
  if (f.active === "0") conds.push(eq(sources.active, false));
  if (f.q) conds.push(or(ilike(sources.name, `%${f.q}%`), ilike(sources.url, `%${f.q}%`))!);
  return db.select({ s: sources, groupSlug: groups.slug, groupName: groups.nameEn }).from(sources).innerJoin(groups, eq(groups.id, sources.groupId))
    .where(and(...conds)).orderBy(groups.order, sources.active, sources.name);
}
export async function listArchivedSources() {
  return db.select({ s: sources, groupName: groups.nameEn, items: sql<number>`(select count(*) from ${items} where ${items.sourceId} = ${sources.id})` })
    .from(sources).innerJoin(groups, eq(groups.id, sources.groupId)).where(isNotNull(sources.archivedAt)).orderBy(desc(sources.archivedAt));
}
/** What depends on a source: fetched items, per-run fetch records, and the stories that cite its items. */
export async function sourceUsage(id: number) {
  const [itemCount, runCount, [cited]] = await Promise.all([
    db.$count(items, eq(items.sourceId, id)),
    db.$count(runSources, eq(runSources.sourceId, id)),
    db.select({ n: sql<number>`count(distinct ${storySources.storyId})` }).from(storySources).innerJoin(items, eq(items.id, storySources.itemId)).where(eq(items.sourceId, id)),
  ]);
  return { items: itemCount, runs: runCount, stories: Number(cited.n) };
}
export async function getSource(id: number) {
  const [row] = await db.select().from(sources).where(eq(sources.id, id));
  return row ?? null;
}

export async function listHandles(group?: string) {
  return db.select({ h: handles, groupSlug: groups.slug, groupName: groups.nameEn }).from(handles).innerJoin(groups, eq(groups.id, handles.groupId))
    .where(group ? eq(groups.slug, group) : undefined).orderBy(groups.order, handles.platform, handles.handle);
}

export async function listGlossary(q?: string) {
  if (q) q = normalizeUrdu(q);
  return db.select().from(glossary).where(q ? or(ilike(glossary.termEn, `%${q}%`), ilike(glossary.termUr, `%${q}%`)) : undefined).orderBy(glossary.kind, glossary.termEn);
}

export async function listEditions(limit = 60) {
  const rows = await db.select().from(editions).orderBy(desc(editions.date), desc(editions.id)).limit(limit);
  const counts = await db.select({ editionId: stories.editionId, n: sql<number>`count(*)`, flagged: sql<number>`count(*) filter (where ${stories.qaStatus} = 'flagged')` }).from(stories).groupBy(stories.editionId);
  const byId = new Map(counts.map((c) => [c.editionId, { n: Number(c.n), flagged: Number(c.flagged) }]));
  return rows.map((e) => ({ ...e, ...(byId.get(e.id) ?? { n: 0, flagged: 0 }) }));
}
export async function getEditionById(id: number) {
  const [e] = await db.select().from(editions).where(eq(editions.id, id));
  if (!e) return null;
  return getEditionFull(e.date, e.slot as Slot, true);
}
export async function getEditionGroupLeads(editionId: number) {
  return db.select().from(editionGroups).where(eq(editionGroups.editionId, editionId));
}

export async function listRuns(limit = 100) {
  return db.select().from(runs).orderBy(desc(runs.startedAt)).limit(limit);
}
export async function getRun(id: number) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, id), with: { sources: { with: { source: true } } } });
  return run ?? null;
}
export async function recentRunsSince(hours: number) {
  return db.select().from(runs).where(gte(runs.startedAt, new Date(Date.now() - hours * 3_600_000)));
}
export { topics };
