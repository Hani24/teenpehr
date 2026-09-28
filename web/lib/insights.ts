import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";

/*
 * Research numbers for the admin Insights page (decision D5), and the entity counters. Days are
 * Karachi days. Stories count once their edition is published; items and searches as they arrive.
 */

type Row = Record<string, unknown>;
const rows = async (q: SQL) => (await db.execute(q)) as unknown as Row[];
const KHI = sql`'Asia/Karachi'`;

/**
 * Recompute entities.mention_count, first_seen_at and last_seen_at from published stories (docs/API.md:
 * they count published stories and move at publish time). Idempotent, and it writes only rows whose
 * numbers changed, so it is cheap to run after every publish; an edition published from the admin is
 * caught up by the next run of it. Entities no published story names keep their times and count 0.
 */
export async function syncEntityStats(): Promise<number> {
  const updated = await rows(sql`with s as (
      select se.entity_id, count(distinct se.story_id)::int as n, min(ed.published_at) as first, max(ed.published_at) as last
      from story_entities se join stories st on st.id = se.story_id join editions ed on ed.id = st.edition_id
      where ed.status = 'published' and ed.published_at is not null group by se.entity_id)
    update entities e set mention_count = s.n, first_seen_at = s.first, last_seen_at = s.last from s
    where e.id = s.entity_id and (e.mention_count, e.first_seen_at, e.last_seen_at) is distinct from (s.n, s.first, s.last)
    returning e.id`);
  const cleared = await rows(sql`update entities e set mention_count = 0 where e.mention_count <> 0 and not exists (
      select 1 from story_entities se join stories st on st.id = se.story_id join editions ed on ed.id = st.edition_id
      where se.entity_id = e.id and ed.status = 'published') returning e.id`);
  return updated.length + cleared.length;
}

export type Trend = { key: string; label: string; labelUr?: string; kind?: string; now: number; before: number };
/** Published stories per topic: the last 7 days against the 7 before. */
export async function trendingTopics(): Promise<Trend[]> {
  const r = await rows(sql`select t.topic,
      count(*) filter (where ed.published_at >= now() - interval '7 days')::int as now,
      count(*) filter (where ed.published_at < now() - interval '7 days')::int as before
    from stories s join editions ed on ed.id = s.edition_id cross join lateral unnest(s.topics) as t(topic)
    where ed.status = 'published' and ed.published_at >= now() - interval '14 days'
    group by t.topic order by now desc, before desc`);
  return r.map((x) => ({ key: String(x.topic), label: String(x.topic), now: Number(x.now), before: Number(x.before) }));
}

/** Entities by published stories naming them: the last 7 days against the 7 before (top `limit` now). */
export async function trendingEntities(limit = 20): Promise<Trend[]> {
  const r = await rows(sql`select en.slug, en.name_en, en.name_ur, en.kind::text as kind,
      count(distinct s.id) filter (where ed.published_at >= now() - interval '7 days')::int as now,
      count(distinct s.id) filter (where ed.published_at < now() - interval '7 days')::int as before
    from story_entities se join stories s on s.id = se.story_id join editions ed on ed.id = s.edition_id join entities en on en.id = se.entity_id
    where ed.status = 'published' and ed.published_at >= now() - interval '14 days'
    group by en.id order by now desc, (count(distinct s.id) filter (where ed.published_at >= now() - interval '7 days')) - (count(distinct s.id) filter (where ed.published_at < now() - interval '7 days')) desc
    limit ${limit}`);
  return r.map((x) => ({ key: String(x.slug), label: String(x.name_en), labelUr: String(x.name_ur), kind: String(x.kind), now: Number(x.now), before: Number(x.before) }));
}

export type SearchStat = { q: string; count: number; readers: number; avgResults: number; last: Date };
/** The most frequent searches of the last `days` days, or only those that found nothing. */
export async function topSearches(opts: { days?: number; zeroOnly?: boolean; limit?: number } = {}): Promise<SearchStat[]> {
  const { days = 30, zeroOnly = false, limit = 20 } = opts;
  const zero = zeroOnly ? sql`and results = 0` : sql``;
  const r = await rows(sql`select q_norm, count(*)::int as count, count(distinct user_id)::int as readers,
      round(avg(results))::int as avg_results, max(created_at) as last
    from search_log where created_at >= now() - make_interval(days => ${days}) and q_norm <> '' ${zero}
    group by q_norm order by count desc, last desc limit ${limit}`);
  return r.map((x) => ({ q: String(x.q_norm), count: Number(x.count), readers: Number(x.readers), avgResults: Number(x.avg_results), last: new Date(x.last as string) }));
}

export async function searchTotals(days = 30): Promise<{ searches: number; zero: number; readers: number }> {
  const [r] = await rows(sql`select count(*)::int as searches, count(*) filter (where results = 0)::int as zero, count(distinct user_id)::int as readers
    from search_log where created_at >= now() - make_interval(days => ${days})`);
  return { searches: Number(r?.searches ?? 0), zero: Number(r?.zero ?? 0), readers: Number(r?.readers ?? 0) };
}

/** Karachi dates of the last `days` days, oldest first (the columns of the per-day tables). */
export function lastDays(days: number, now = new Date()): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" });
  return Array.from({ length: days }, (_, i) => fmt.format(new Date(now.getTime() - (days - 1 - i) * 86_400_000)));
}

export type DayMatrix = { rows: Array<{ key: string; label: string; perDay: Record<string, number>; total: number }>; days: string[] };
const matrix = (r: Row[], days: string[]): DayMatrix => {
  const by = new Map<string, DayMatrix["rows"][number]>();
  for (const x of r) {
    const key = String(x.key);
    const row = by.get(key) ?? { key, label: String(x.label), perDay: {}, total: 0 };
    row.perDay[String(x.day)] = Number(x.count);
    row.total += Number(x.count);
    by.set(key, row);
  }
  return { rows: [...by.values()], days };
};

/** Published stories per group per edition date. */
export async function storiesPerGroupPerDay(days = 14): Promise<DayMatrix> {
  const r = await rows(sql`select g.slug as key, g.name_en as label, ed.date::text as day, count(*)::int as count, min(g."order") as ord
    from stories s join editions ed on ed.id = s.edition_id join groups g on g.id = s.group_id
    where ed.status = 'published' and ed.date > (now() at time zone ${KHI})::date - ${days}::int
    group by g.slug, g.name_en, ed.date order by ord, g.slug, day`);
  return matrix(r, lastDays(days));
}

/** New items per feed per day (first sighting by that feed), the busiest `limit` feeds. */
export async function itemsPerSourcePerDay(days = 7, limit = 40): Promise<DayMatrix> {
  const r = await rows(sql`with d as (
      select isr.source_id, (isr.first_seen_at at time zone ${KHI})::date as day, count(*)::int as count
      from item_sources isr where isr.first_seen_at >= now() - make_interval(days => ${days}) group by 1, 2),
    top as (select source_id from d group by source_id order by sum(count) desc limit ${limit})
    select src.id::text as key, src.name as label, d.day::text as day, d.count from d join top using (source_id) join sources src on src.id = d.source_id
    order by src.name, day`);
  const m = matrix(r, lastDays(days));
  m.rows.sort((a, b) => b.total - a.total);
  return m;
}

export type RevisionStats = {
  week: number; month: number; items: number;
  bySource: Array<{ name: string; revisions: number; items: number }>;
  recent: Array<{ itemId: number; source: string; first: string; now: string; seenAt: Date; url: string; textOnly: boolean }>;
};
/** Headline history: revisions recorded in the last 7 and 30 days, by feed, and the latest ones. */
export async function revisionStats(): Promise<RevisionStats> {
  const [t] = await rows(sql`select count(*) filter (where seen_at >= now() - interval '7 days')::int as week, count(*)::int as month, count(distinct item_id)::int as items
    from item_revisions where seen_at >= now() - interval '30 days'`);
  const bySource = await rows(sql`select src.name, count(*)::int as revisions, count(distinct r.item_id)::int as items
    from item_revisions r join items i on i.id = r.item_id join sources src on src.id = i.source_id
    where r.seen_at >= now() - interval '30 days' group by src.id order by revisions desc limit 15`);
  // A revision whose headline equals the one before it (the item's own, for the first) changed only the text.
  const recent = await rows(sql`select * from (
      select r.id, r.item_id, src.name as source, i.title as first, r.title as now, r.seen_at, i.url,
        regexp_replace(coalesce(lag(r.title) over (partition by r.item_id order by r.seen_at, r.id), i.title), '\\s+', ' ', 'g')
          = regexp_replace(r.title, '\\s+', ' ', 'g') as text_only
      from item_revisions r join items i on i.id = r.item_id join sources src on src.id = i.source_id
      where r.item_id in (select item_id from item_revisions order by seen_at desc, id desc limit 15)) x
    order by x.seen_at desc, x.id desc limit 15`);
  return {
    week: Number(t?.week ?? 0), month: Number(t?.month ?? 0), items: Number(t?.items ?? 0),
    bySource: bySource.map((x) => ({ name: String(x.name), revisions: Number(x.revisions), items: Number(x.items) })),
    recent: recent.map((x) => ({ itemId: Number(x.item_id), source: String(x.source), first: String(x.first), now: String(x.now), seenAt: new Date(x.seen_at as string), url: String(x.url), textOnly: x.text_only === true })),
  };
}

export type Coverage = {
  mix: Array<{ coverage: string; stories: number }>;
  stories: number;
  bySource: Array<{ name: string; perspective: string; group: string; stories: number; primary: number }>;
};
/** Which outlets, with their perspectives, the published stories of the last `days` days cite. */
export async function coverageByPerspective(days = 30): Promise<Coverage> {
  const since = sql`ed.status = 'published' and ed.published_at >= now() - make_interval(days => ${days})`;
  const mix = await rows(sql`select coalesce(s.coverage::text, 'unset') as coverage, count(*)::int as stories
    from stories s join editions ed on ed.id = s.edition_id where ${since} group by 1 order by stories desc`);
  const bySource = await rows(sql`select src.name, src.perspective, g.name_en as grp, count(distinct s.id)::int as stories,
      count(distinct s.id) filter (where ss.is_primary)::int as primary_cites
    from story_sources ss join stories s on s.id = ss.story_id join editions ed on ed.id = s.edition_id
    join items i on i.id = ss.item_id join sources src on src.id = i.source_id join groups g on g.id = src.group_id
    where ${since} group by src.id, g.name_en order by stories desc, src.name limit 40`);
  return {
    mix: mix.map((x) => ({ coverage: String(x.coverage), stories: Number(x.stories) })),
    stories: mix.reduce((n, x) => n + Number(x.stories), 0),
    bySource: bySource.map((x) => ({ name: String(x.name), perspective: String(x.perspective), group: String(x.grp), stories: Number(x.stories), primary: Number(x.primary_cites) })),
  };
}
