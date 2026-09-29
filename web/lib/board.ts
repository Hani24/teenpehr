import "server-only";
import { unstable_cache } from "next/cache";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { EDITIONS_TAG } from "./cache-tags";
import type { Slot } from "./urdu";

/*
 * The X board (decision D10): recent posts from the watched handles (X and Bluesky, and any other platform
 * the collectors fill) and from the members of each section's approved X Lists, per section, ranked in SQL by relevance to the latest
 * published edition, then engagement, then recency. Relevance counts, in the post's own text:
 *   - being cited by a story (the latest edition's counts most),
 *   - the latest edition's entities (English and Urdu names and aliases) and story keywords,
 *   - the section's topic keywords from the admin (topics.keywords_en/_ur, times their boost),
 * each matched as a whole word, case-insensitive, with Arabic yeh/kaf read as the Urdu letters. Replies and
 * bare reposts keep only 40% of their relevance and sort after original posts of equal weight. Posts are
 * shown verbatim and never paraphrased; nothing here reads or returns their images (posts.media).
 *
 * Posts arrive from the collector between editions, so the board is cached for BOARD_CACHE_S and expired
 * with the editions (EDITIONS_TAG: a newly published edition changes the ranking at once).
 */

export const BOARD_HOURS = 72;
export const BOARD_PAGE_SIZE = 20;
export const BOARD_MAX_PAGES = 25;
const BOARD_CACHE_S = 300;

export type BoardPlatform = "x" | "bluesky" | "telegram" | "youtube";
export type BoardPost = {
  id: number;
  platform: BoardPlatform;
  authorHandle: string;
  authorName: string;
  text: string;
  url: string;
  /** ISO 8601 (UTC). */
  postedAt: string;
  isRepost: boolean;
  isReply: boolean;
  /** The platform's language tag for the post, when the collector had one. */
  lang: string | null;
  groupId: number;
  relevance: number;
  /** Up to three of the edition's entities (English and Urdu names) or keywords (English only) the post mentions. */
  matched: { en: string; ur: string }[];
  /** The newest published (or live desk) story citing the post. */
  cited: { id: number; titleEn: string; titleUr: string } | null;
};
export type BoardBasis = { id: number; date: string; slot: Slot } | null;
export type BoardPage = { posts: BoardPost[]; total: number; basis: BoardBasis };
export type BoardOverview = {
  /** Posts in the window, all sections and per group id. */
  total: number;
  byGroup: Record<number, number>;
  /** Group ids with approved X Lists (groups.x_list_ids). */
  xListGroups: number[];
  /** Active watched handles per platform, overall and per group id. */
  handles: Record<BoardPlatform, number>;
  handlesByGroup: Record<number, Partial<Record<BoardPlatform, number>>>;
  newest: string | null;
  basis: BoardBasis;
};

type Row = Record<string, unknown>;
const rows = async (q: SQL) => (await db.execute(q)) as unknown as Row[];
const iso = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
/** A metric from posts.metrics as a non-negative number (0 when missing or not a number). */
const metric = (k: string) => sql.raw(`greatest(0, case when jsonb_typeof(c.metrics -> '${k}') = 'number' then (c.metrics ->> '${k}')::float8 else 0 end)`);
/** A whole-word, case-insensitive pattern for a lower-cased term (regex specials escaped). */
const wordRe = (col: string) => sql.raw(`'(^|[^[:alnum:]])' || regexp_replace(${col}, '([.^$*+?()\\[\\]{}|\\\\-])', '\\\\\\1', 'g') || '($|[^[:alnum:]])'`);

const LATEST = sql`select id, date::text as date, slot::text as slot from editions where status = 'published' order by date desc, slot desc limit 1`;
/**
 * A post's section: its watched handle's group (an active handle), else the group whose approved X List
 * carried it (posts.raw.x_list_id, set by the collector; groups.x_list_ids is the owner's approval), so a
 * public list's members show under that section although nobody watches them one by one. Joins as `g`.
 */
const POST_GROUP = sql.raw(`left join handles h on h.id = p.handle_id and h.active
      join groups g on g.id = coalesce(h.group_id, (
        select lg.id from groups lg where p.platform = 'x' and p.raw ->> 'x_list_id' is not null
          and (p.raw ->> 'x_list_id') = any(lg.x_list_ids) order by lg."order", lg.id limit 1))`);

async function loadBoard(groupId: number | null, page: number): Promise<BoardPage> {
  const offset = (page - 1) * BOARD_PAGE_SIZE;
  const r = await rows(sql`
    with latest as (${LATEST}),
    raw_terms as (
      select t as name, 'entity' as kind, e.name_en as en, e.name_ur as ur from latest l
        join stories s on s.edition_id = l.id and s.withdrawn_at is null
        join story_entities se on se.story_id = s.id
        join entities e on e.id = se.entity_id
        cross join lateral unnest(array[e.name_en, e.name_ur] || e.aliases) as t
      union all
      select k, 'keyword', k, '' from latest l join stories s on s.edition_id = l.id and s.withdrawn_at is null cross join lateral unnest(s.keywords) as k
    ),
    terms as (
      select distinct on (lower(btrim(name))) btrim(name) as name, kind, en, ur, lower(btrim(name)) as term
      from raw_terms where char_length(btrim(coalesce(name, ''))) >= 3
      order by lower(btrim(name)), kind
    ),
    terms_re as (select *, ${wordRe("term")} as re from terms),
    topic_terms as (
      select tp.group_id, lower(btrim(k)) as term, max(tp.boost) as boost
      from topics tp cross join lateral unnest(tp.keywords_en || tp.keywords_ur) as k
      where char_length(btrim(k)) >= 3 group by 1, 2
    ),
    topic_re as (select *, ${wordRe("term")} as re from topic_terms),
    cand as (
      select p.id, p.platform::text as platform, p.author_handle, p.author_name, p.text, p.url, p.posted_at, p.is_repost, p.in_reply_to, p.lang, p.metrics, g.id as group_id,
        translate(lower(p.text), 'يكى', 'یکی') as lt
      from posts p ${POST_GROUP}
      where g.active and p.posted_at > now() - make_interval(hours => ${BOARD_HOURS}) and p.posted_at < now() + interval '1 hour'
        ${groupId === null ? sql`` : sql`and g.id = ${groupId}`}
    ),
    scored as (
      select c.*, coalesce(m.ent, 0) as ent, coalesce(m.kw, 0) as kw, coalesce(m.names, '[]'::jsonb) as names, coalesce(tp.score, 0) as tp,
        cited.story_id, cited.title_en, cited.title_ur, coalesce(cited.in_latest, false) as in_latest,
        ln(1 + ${metric("likes")} + 2 * ${metric("reposts")} + ${metric("replies")} + ${metric("quotes")}) as engagement
      from cand c
      left join lateral (
        -- One count per entity or keyword, however many of its names (English, Urdu, aliases) the post uses.
        select count(*) filter (where d.kind = 'entity')::int as ent, count(*) filter (where d.kind = 'keyword')::int as kw,
          jsonb_agg(jsonb_build_object('en', d.en, 'ur', d.ur) order by d.kind, char_length(d.en) desc) as names
        from (
          select distinct on (t.en, t.ur) t.kind, t.en, t.ur from terms_re t
          where strpos(c.lt, t.term) > 0 and c.lt ~ t.re order by t.en, t.ur, t.kind
        ) d
      ) m on true
      left join lateral (
        select sum(tt.boost)::int as score from topic_re tt where tt.group_id = c.group_id and strpos(c.lt, tt.term) > 0 and c.lt ~ tt.re
      ) tp on true
      left join lateral (
        select s.id as story_id, s.title_en, s.title_ur, s.edition_id = (select id from latest) as in_latest
        from story_posts sp join stories s on s.id = sp.story_id join editions e on e.id = s.edition_id
        where sp.post_id = c.id and (e.status = 'published' or s.desk_at is not null) and s.withdrawn_at is null
        order by e.date desc, e.slot desc, s.id desc limit 1
      ) cited on true
    ),
    ranked as (
      select *, (is_repost or in_reply_to is not null) as demoted,
        (case when in_latest then 8 when story_id is not null then 4 else 0 end + 3 * least(ent, 3) + 2 * least(kw, 3) + least(tp, 4))::int as relevance
      from scored
    )
    select id, platform, author_handle, author_name, text, url, ${iso("posted_at")} as posted_at, is_repost, (in_reply_to is not null) as is_reply, lang,
      group_id, relevance, names, story_id, title_en, title_ur, (count(*) over ())::int as total
    from ranked
    order by relevance * (case when demoted then 0.4 else 1 end) desc, demoted, engagement desc, posted_at desc, id desc
    limit ${BOARD_PAGE_SIZE} offset ${offset}
  `);
  const [basis] = await rows(LATEST);
  return {
    total: r.length ? Number(r[0].total) : 0,
    basis: basis ? { id: Number(basis.id), date: String(basis.date), slot: String(basis.slot) as Slot } : null,
    posts: r.map((x) => ({
      id: Number(x.id), platform: String(x.platform) as BoardPlatform, authorHandle: String(x.author_handle), authorName: String(x.author_name ?? ""),
      text: String(x.text), url: String(x.url), postedAt: String(x.posted_at), isRepost: !!x.is_repost, isReply: !!x.is_reply, lang: x.lang == null ? null : String(x.lang),
      groupId: Number(x.group_id), relevance: Number(x.relevance), matched: Array.isArray(x.names) ? (x.names as { en?: unknown; ur?: unknown }[]).map((n) => ({ en: String(n.en ?? ""), ur: String(n.ur ?? "") })).filter((n) => n.en || n.ur).slice(0, 3) : [],
      cited: x.story_id == null ? null : { id: Number(x.story_id), titleEn: String(x.title_en ?? ""), titleUr: String(x.title_ur ?? "") },
    })),
  };
}

async function loadOverview(): Promise<BoardOverview> {
  const [counts, handles, lists, [basis]] = await Promise.all([
    rows(sql`select g.id as group_id, count(*)::int as n, ${iso("max(p.posted_at)")} as newest from posts p ${POST_GROUP}
      where g.active and p.posted_at > now() - make_interval(hours => ${BOARD_HOURS}) and p.posted_at < now() + interval '1 hour' group by g.id`),
    rows(sql`select h.group_id, h.platform::text as platform, count(*)::int as n from handles h join groups g on g.id = h.group_id where h.active and g.active group by 1, 2`),
    rows(sql`select id from groups where active and cardinality(x_list_ids) > 0`),
    rows(LATEST),
  ]);
  const byGroup: Record<number, number> = {};
  let total = 0, newest: string | null = null;
  for (const c of counts) {
    byGroup[Number(c.group_id)] = Number(c.n); total += Number(c.n);
    if (c.newest && (!newest || String(c.newest) > newest)) newest = String(c.newest);
  }
  const h: Record<BoardPlatform, number> = { x: 0, bluesky: 0, telegram: 0, youtube: 0 };
  const handlesByGroup: BoardOverview["handlesByGroup"] = {};
  for (const r of handles) {
    const p = String(r.platform) as BoardPlatform, g = Number(r.group_id), n = Number(r.n);
    h[p] = (h[p] ?? 0) + n;
    (handlesByGroup[g] ??= {})[p] = n;
  }
  return {
    total, byGroup, newest, handles: h, handlesByGroup, xListGroups: lists.map((l) => Number(l.id)),
    basis: basis ? { id: Number(basis.id), date: String(basis.date), slot: String(basis.slot) as Slot } : null,
  };
}

const cachedBoard = unstable_cache(loadBoard, ["x-board", "v5"], { tags: [EDITIONS_TAG], revalidate: BOARD_CACHE_S });
const cachedOverview = unstable_cache(loadOverview, ["x-board-overview", "v4"], { tags: [EDITIONS_TAG], revalidate: BOARD_CACHE_S });

/** One page of the board, for one group (its id) or all of them (null). */
export async function getBoard(groupId: number | null, page: number): Promise<BoardPage> {
  return cachedBoard(groupId, page);
}
/** Counts for the tabs and the empty states: posts per group, X Lists, watched handles. */
export async function getBoardOverview(): Promise<BoardOverview> {
  return cachedOverview();
}
