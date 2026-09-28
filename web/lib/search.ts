import "server-only";
import { cache } from "react";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { isEventType, isTopic, TOPICS } from "./taxonomy";
import { normalizeUrdu, type Locale, type Slot } from "./urdu";
import { isEditionDate } from "./view";

/*
 * Reader search, topic and entity pages (decision D5). Everything here reads published stories only;
 * drafts and held editions never show up in a result, a count or a chart.
 */

export const PAGE_SIZE = 20;
export const MAX_PAGE = 50;
const Q_MAX = 200;
/** ts_headline markers: control characters no story text contains, split into <mark> by the page. */
export const MARK_START = "\u0001";
export const MARK_END = "\u0002";

const slugParam = z.string().trim().max(120).regex(/^[a-z0-9][a-z0-9-]*$/);
// A real calendar date: Date.parse rolls 2026-02-31 over to March, which Postgres would then refuse.
const dateParam = z.string().refine(isEditionDate);
const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const blank = (v: unknown) => { const x = one(v); return typeof x === "string" && x.trim() !== "" ? x.trim() : undefined; };

/** The search page's query string, validated. A bad value is dropped and reported, never a crash. */
export const searchParamsSchema = z.object({
  q: z.preprocess(one, z.string().max(1000).optional()).transform((s) => (s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, Q_MAX)),
  group: z.preprocess(blank, slugParam.optional()),
  topic: z.preprocess(blank, z.enum(TOPICS).optional()),
  entity: z.preprocess(blank, slugParam.optional()),
  from: z.preprocess(blank, dateParam.optional()),
  to: z.preprocess(blank, dateParam.optional()),
  page: z.preprocess(blank, z.coerce.number().int().min(1).max(MAX_PAGE).optional()).transform((n) => n ?? 1),
});
export type SearchParams = z.infer<typeof searchParamsSchema>;

/** Parse each field on its own, so one bad field (a typo in a date) costs only that filter. */
export function parseSearchParams(raw: Record<string, string | string[] | undefined>): { params: SearchParams; invalid: string[] } {
  const invalid: string[] = [];
  const shape = searchParamsSchema.shape;
  const pick = <K extends keyof typeof shape>(k: K) => {
    const r = shape[k].safeParse(raw[k]);
    if (!r.success) { invalid.push(k); return shape[k].parse(undefined); }
    return r.data;
  };
  const params = { q: pick("q"), group: pick("group"), topic: pick("topic"), entity: pick("entity"), from: pick("from"), to: pick("to"), page: pick("page") } as SearchParams;
  if (params.from && params.to && params.from > params.to) { invalid.push("to"); params.to = undefined; }
  return { params, invalid };
}

/** Search text as matched: NFC, one space between words, Urdu code points (ی ک ہ) for Arabic-script input. */
export function normalizeQuery(q: string): string {
  // Control characters are never search text (NUL fails the query outright, U+0001/2 are the markers).
  const s = q.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, Q_MAX);
  return /[؀-ۿ]/.test(s) ? normalizeUrdu(s) : s;
}
/** search_log.q_norm: the matched text, lower-cased, so "IMF" and "imf" count as one search. */
export const qNorm = (q: string) => normalizeQuery(q).toLowerCase();

export type StoryHit = {
  id: number; titleEn: string; titleUr: string; snippet: string; snippetLang: Locale;
  /** The title in the page's language with the matched words marked (full-text matches only). */
  titleMarked: string | null;
  topics: string[]; eventType: string | null; date: string; slot: Slot;
  groupSlug: string; groupEn: string; groupUr: string;
};
export type SearchResult = { hits: StoryHit[]; total: number; mode: "fts" | "fuzzy" | "browse" };

type Row = Record<string, unknown>;
const toHit = (r: Row): StoryHit => ({
  id: Number(r.id), titleEn: String(r.title_en), titleUr: String(r.title_ur ?? ""), snippet: String(r.snippet ?? ""), snippetLang: r.snippet_lang === "ur" ? "ur" : "en",
  titleMarked: typeof r.title_hl === "string" ? r.title_hl : null,
  topics: (r.topics as string[] | null) ?? [], eventType: (r.event_type as string | null) ?? null, date: String(r.date), slot: r.slot as Slot,
  groupSlug: String(r.group_slug), groupEn: String(r.group_en), groupUr: String(r.group_ur),
});
const rows = async (q: SQL) => (await db.execute(q)) as unknown as Row[];

/** Filters shared by search and browsing: published only, then group, topic, entity and date range. */
function filterSql(p: Pick<SearchParams, "group" | "topic" | "entity" | "from" | "to">): SQL {
  const parts: SQL[] = [sql`ed.status = 'published'`];
  if (p.group) parts.push(sql`g.slug = ${p.group}`);
  if (p.topic) parts.push(sql`s.topics @> array[${p.topic}]::text[]`);
  if (p.entity) parts.push(sql`exists (select 1 from story_entities se join entities en on en.id = se.entity_id where se.story_id = s.id and en.slug = ${p.entity})`);
  if (p.from) parts.push(sql`ed.date >= ${p.from}::date`);
  if (p.to) parts.push(sql`ed.date <= ${p.to}::date`);
  return sql.join(parts, sql` and `);
}

const HEADLINE_OPTS = `StartSel=${MARK_START}, StopSel=${MARK_END}, MaxWords=35, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "`;
const TITLE_OPTS = `StartSel=${MARK_START}, StopSel=${MARK_END}, HighlightAll=true`;

/**
 * Full-text search over published stories. English runs through the stemmed 'english' vector
 * (websearch syntax: quotes, OR, -word), Urdu and any other script through the 'simple' one; both are
 * tried for every query, so a reader can type either script on either page. When neither matches, a
 * trigram pass on the titles catches misspellings. Snippets come from ts_headline in the page's language.
 */
export async function searchStories(p: SearchParams, locale: Locale): Promise<SearchResult> {
  const q = normalizeQuery(p.q);
  const where = filterSql(p);
  const offset = (p.page - 1) * PAGE_SIZE;
  const base = sql`from stories s join editions ed on ed.id = s.edition_id join groups g on g.id = s.group_id`;
  const cols = sql`s.id, s.title_en, s.title_ur, s.topics, s.event_type, ed.date::text as date, ed.slot::text as slot, g.slug as group_slug, g.name_en as group_en, g.name_ur as group_ur`;
  if (!q) {
    const r = await rows(sql`select ${cols}, count(*) over() as total,
        case when ${locale} = 'ur' and s.summary_ur <> '' then 'ur' else 'en' end as snippet_lang,
        left(case when ${locale} = 'ur' and s.summary_ur <> '' then s.summary_ur else s.summary_en end, 320) as snippet
      ${base} where ${where} order by ed.date desc, ed.slot desc, s.group_id, s.order, s.id limit ${PAGE_SIZE} offset ${offset}`);
    return { hits: r.map(toHit), total: Number(r[0]?.total ?? 0), mode: "browse" };
  }
  const en = sql`websearch_to_tsquery('english', ${q})`, si = sql`websearch_to_tsquery('simple', ${q})`;
  const matches = sql`(s.search_en @@ ${en} or s.search_ur @@ ${si})`;
  // s.id breaks ties, so a story never shows on two pages (or none) of the same search.
  const fts = await rows(sql`with m as (
      select ${cols}, ed.slot as slot_order, s.summary_en, s.summary_ur, count(*) over() as total,
        ts_rank_cd(s.search_en, ${en}) + ts_rank_cd(s.search_ur, ${si}) as rank
      ${base} where ${where} and ${matches}
      order by rank desc, ed.date desc, ed.slot desc, s.id desc limit ${PAGE_SIZE} offset ${offset})
    select m.*, case when ${locale} = 'ur' and m.summary_ur <> '' then 'ur' else 'en' end as snippet_lang,
      case when ${locale} = 'ur' and m.summary_ur <> '' then ts_headline('simple', m.summary_ur, ${si}, ${HEADLINE_OPTS})
           else ts_headline('english', m.summary_en, ${en}, ${HEADLINE_OPTS}) end as snippet,
      case when ${locale} = 'ur' and m.title_ur <> '' then ts_headline('simple', m.title_ur, ${si}, ${TITLE_OPTS})
           else ts_headline('english', m.title_en, ${en}, ${TITLE_OPTS}) end as title_hl
    from m order by m.rank desc, m.date desc, m.slot_order desc, m.id desc`);
  if (fts.length || q.length < 3) return { hits: fts.map(toHit), total: Number(fts[0]?.total ?? 0), mode: "fts" };
  if (p.page > 1) {
    // An empty later page is either past the end of the word matches (keep their count) or a later page
    // of close headlines, which only run when nothing matched as words.
    const [c] = await rows(sql`select count(*)::int as n ${base} where ${where} and ${matches}`);
    if (Number(c?.n ?? 0) > 0) return { hits: [], total: Number(c.n), mode: "fts" };
  }
  // Nothing matched as words: look for a title with a word close to the query (pg_trgm, indexed). The
  // default word-similarity cut-off (0.6) misses a swapped pair of letters ("tranhce"); 0.45 does not.
  const fuzzy = await db.transaction(async (tx) => {
    await tx.execute(sql`set local pg_trgm.word_similarity_threshold = 0.45`);
    return (await tx.execute(sql`select ${cols}, count(*) over() as total,
      case when ${locale} = 'ur' and s.summary_ur <> '' then 'ur' else 'en' end as snippet_lang,
      left(case when ${locale} = 'ur' and s.summary_ur <> '' then s.summary_ur else s.summary_en end, 320) as snippet
    ${base} where ${where} and (${q} <% s.title_en or ${q} <% s.title_ur)
    order by greatest(word_similarity(${q}, s.title_en), word_similarity(${q}, s.title_ur)) desc, ed.date desc, s.id desc
    limit ${PAGE_SIZE} offset ${offset}`)) as unknown as Row[];
  });
  return { hits: fuzzy.map(toHit), total: Number(fuzzy[0]?.total ?? 0), mode: "fuzzy" };
}

/** The same reader running the same search again within this long (a reload, back and forward) is one search. */
const SEARCH_REPEAT_MINUTES = 10;

/**
 * One row in search_log per search a reader runs (page 1 of a query or filter set), unless the same
 * reader logged the same words, language and filters in the last SEARCH_REPEAT_MINUTES. Never throws.
 */
export async function logSearch(entry: { userId: number | null; q: string; locale: Locale; filters: Record<string, unknown>; results: number }) {
  const l = schema.searchLog;
  const norm = qNorm(entry.q), filters = JSON.stringify(entry.filters);
  try {
    await db.execute(sql`insert into ${l} (user_id, q, q_norm, locale, filters, results)
      select ${entry.userId}::int, ${entry.q}::text, ${norm}::text, ${entry.locale}::text, ${filters}::jsonb, ${entry.results}::int
      where not exists (select 1 from ${l} where ${l.userId} is not distinct from ${entry.userId}::int and ${l.qNorm} = ${norm}
        and ${l.locale} = ${entry.locale} and ${l.filters} = ${filters}::jsonb
        and ${l.createdAt} > now() - make_interval(mins => ${SEARCH_REPEAT_MINUTES}))`);
  } catch (e) {
    console.error("search_log insert failed:", (e as Error).message);
  }
}

// ---- topic and entity pages ------------------------------------------------------------------
export type Scope = { topic: string } | { entityId: number };
const scopeSql = (s: Scope) => ("topic" in s
  ? sql`s.topics @> array[${s.topic}]::text[]`
  : sql`exists (select 1 from story_entities se where se.story_id = s.id and se.entity_id = ${s.entityId})`);

/** Published stories in a topic or naming an entity, newest edition first. */
export async function scopedStories(scope: Scope, page: number, locale: Locale): Promise<{ hits: StoryHit[]; total: number }> {
  const r = await rows(sql`select s.id, s.title_en, s.title_ur, s.topics, s.event_type, ed.date::text as date, ed.slot::text as slot,
      g.slug as group_slug, g.name_en as group_en, g.name_ur as group_ur, count(*) over() as total,
      case when ${locale} = 'ur' and s.summary_ur <> '' then 'ur' else 'en' end as snippet_lang,
      left(case when ${locale} = 'ur' and s.summary_ur <> '' then s.summary_ur else s.summary_en end, 320) as snippet
    from stories s join editions ed on ed.id = s.edition_id join groups g on g.id = s.group_id
    where ed.status = 'published' and ${scopeSql(scope)}
    order by ed.date desc, ed.slot desc, s.group_id, s.order, s.id limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`);
  return { hits: r.map(toHit), total: Number(r[0]?.total ?? 0) };
}

export type WeekCount = { week: string; count: number };
/** Published stories per week (Monday start, by edition date) over the last `weeks` weeks, zeros included. */
export async function weeklyCounts(scope: Scope, weeks = 12): Promise<WeekCount[]> {
  const r = await rows(sql`with w as (
      select generate_series(date_trunc('week', (now() at time zone 'Asia/Karachi')::date) - make_interval(weeks => ${weeks - 1}),
                             date_trunc('week', (now() at time zone 'Asia/Karachi')::date), interval '1 week')::date as week)
    select w.week::text as week, count(s.id)::int as count from w
    left join editions ed on ed.status = 'published' and date_trunc('week', ed.date)::date = w.week
    left join stories s on s.edition_id = ed.id and ${scopeSql(scope)}
    group by w.week order by w.week`);
  return r.map((x) => ({ week: String(x.week), count: Number(x.count) }));
}

export type EntityRef = { slug: string; nameEn: string; nameUr: string; kind: string; count: number };
/** Entities most often named in the scope's stories (excluding the entity itself on its own page). */
export async function relatedEntities(scope: Scope, limit = 12): Promise<EntityRef[]> {
  const self = "entityId" in scope ? sql`and en.id <> ${scope.entityId}` : sql``;
  const r = await rows(sql`select en.slug, en.name_en, en.name_ur, en.kind::text as kind, count(distinct s.id)::int as count
    from stories s join editions ed on ed.id = s.edition_id join story_entities se on se.story_id = s.id join entities en on en.id = se.entity_id
    where ed.status = 'published' and ${scopeSql(scope)} ${self}
    group by en.id order by count desc, max(ed.date) desc limit ${limit}`);
  return r.map((x) => ({ slug: String(x.slug), nameEn: String(x.name_en), nameUr: String(x.name_ur), kind: String(x.kind), count: Number(x.count) }));
}

/** Topics of the scope's stories by how many carry them (excluding the topic itself on its own page). */
export async function relatedTopics(scope: Scope, limit = 8): Promise<Array<{ topic: string; count: number }>> {
  const self = "topic" in scope ? sql`and t.topic <> ${scope.topic}` : sql``;
  const r = await rows(sql`select t.topic, count(*)::int as count
    from stories s join editions ed on ed.id = s.edition_id cross join lateral unnest(s.topics) as t(topic)
    where ed.status = 'published' and ${scopeSql(scope)} ${self}
    group by t.topic order by count desc limit ${limit}`);
  return r.map((x) => ({ topic: String(x.topic), count: Number(x.count) })).filter((x) => isTopic(x.topic));
}

export type EntityPage = { id: number; slug: string; kind: string; nameEn: string; nameUr: string; aliases: string[]; mentions: number; first: Date | null; last: Date | null };
/** An entity with its published mentions counted live; null when no published story names it. */
export async function getEntityBySlug(slug: string): Promise<EntityPage | null> {
  if (!slugParam.safeParse(slug).success) return null;
  const [r] = await rows(sql`select en.id, en.slug, en.kind::text as kind, en.name_en, en.name_ur, en.aliases,
      count(distinct s.id)::int as mentions, min(ed.published_at) as first, max(ed.published_at) as last
    from entities en join story_entities se on se.entity_id = en.id join stories s on s.id = se.story_id
    join editions ed on ed.id = s.edition_id and ed.status = 'published'
    where en.slug = ${slug} group by en.id`);
  if (!r) return null;
  const date = (v: unknown) => (v ? new Date(v as string) : null);
  return { id: Number(r.id), slug: String(r.slug), kind: String(r.kind), nameEn: String(r.name_en), nameUr: String(r.name_ur), aliases: (r.aliases as string[]) ?? [], mentions: Number(r.mentions), first: date(r.first), last: date(r.last) };
}

/** Published stories per topic, for the topic index on the search page. */
export const topicCounts = cache(async (): Promise<Map<string, number>> => {
  const r = await rows(sql`select t.topic, count(*)::int as count from stories s join editions ed on ed.id = s.edition_id
    cross join lateral unnest(s.topics) as t(topic) where ed.status = 'published' group by t.topic`);
  return new Map(r.map((x) => [String(x.topic), Number(x.count)]));
});

export const getSearchGroups = cache(async () =>
  db.select({ slug: schema.groups.slug, nameEn: schema.groups.nameEn, nameUr: schema.groups.nameUr }).from(schema.groups).orderBy(schema.groups.order));

// ---- chips on story cards and pages --------------------------------------------------------------
export type EntityChip = { slug: string; nameEn: string; nameUr: string; kind: string; salience: number | null };

/** Every story's entities in one edition, most salient first: one query per edition per request. */
export const getEditionEntityChips = cache(async (editionId: number): Promise<Map<number, EntityChip[]>> => {
  const r = await rows(sql`select se.story_id, en.slug, en.name_en, en.name_ur, en.kind::text as kind, se.salience
    from story_entities se join stories s on s.id = se.story_id join entities en on en.id = se.entity_id
    where s.edition_id = ${editionId} order by se.story_id, se.salience desc nulls last, en.name_en`);
  const map = new Map<number, EntityChip[]>();
  for (const x of r) {
    const id = Number(x.story_id);
    map.set(id, [...(map.get(id) ?? []), { slug: String(x.slug), nameEn: String(x.name_en), nameUr: String(x.name_ur), kind: String(x.kind), salience: x.salience == null ? null : Number(x.salience) }]);
  }
  return map;
});

/** The event type slug, or null when it is not one this build knows. */
export const knownEventType = (s: string | null | undefined) => (s && isEventType(s) ? s : null);
