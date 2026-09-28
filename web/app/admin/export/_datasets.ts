import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";

/*
 * Research exports (decision D5; owner only, app/admin/export). Each dataset is read in keyset pages
 * so a download streams however large the table grows, without a long-lived cursor or transaction.
 */

type Row = Record<string, unknown>;
export type Dataset = {
  title: string;
  description: string;
  columns: string[];
  /** Rows after `after` (null: from the start), in key order. */
  page: (after: unknown[] | null, limit: number) => Promise<Row[]>;
  /** The key of a row, passed back to page() for the next batch. */
  key: (r: Row) => unknown[];
  count: () => Promise<number>;
};

const rows = async (q: SQL) => (await db.execute(q)) as unknown as Row[];
const countOf = (table: SQL) => async () => Number((await rows(sql`select count(*)::int as n from ${table}`))[0]?.n ?? 0);
const afterId = (after: unknown[] | null, col: SQL) => (after ? sql`${col} > ${after[0]}` : sql`true`);

export const DATASETS: Record<string, Dataset> = {
  stories: {
    title: "Stories",
    description: "Every story with its edition, section, text in both languages, research metadata (keywords, topics, countries, places, event type), cited items, posts and entities. edition_status tells published stories from drafts.",
    columns: ["id", "edition_id", "date", "slot", "edition_status", "published_at", "group", "order", "thread", "tag", "coverage", "qa_status", "qa_note", "title_en", "title_ur", "summary_en", "summary_ur", "why_en", "why_ur", "contested_en", "contested_ur", "keywords", "topics", "countries", "places", "event_type", "word_count", "reading_time_sec", "primary_item_id", "item_ids", "post_ids", "entities", "created_at"],
    page: (after, limit) => rows(sql`select s.id, s.edition_id, ed.date::text as date, ed.slot::text as slot, ed.status::text as edition_status, ed.published_at,
        g.slug as "group", s."order", th.slug as thread, s.tag::text as tag, s.coverage::text as coverage, s.qa_status::text as qa_status, s.qa_note,
        s.title_en, s.title_ur, s.summary_en, s.summary_ur, s.why_en, s.why_ur, s.contested_en, s.contested_ur,
        s.keywords, s.topics, s.countries, s.places, s.event_type, s.word_count, s.reading_time_sec,
        (select ss.item_id from story_sources ss where ss.story_id = s.id and ss.is_primary limit 1) as primary_item_id,
        coalesce((select array_agg(ss.item_id order by ss.item_id) from story_sources ss where ss.story_id = s.id), '{}') as item_ids,
        coalesce((select array_agg(sp.post_id order by sp.post_id) from story_posts sp where sp.story_id = s.id), '{}') as post_ids,
        coalesce((select array_agg(en.slug order by se.salience desc nulls last) from story_entities se join entities en on en.id = se.entity_id where se.story_id = s.id), '{}') as entities,
        s.created_at
      from stories s join editions ed on ed.id = s.edition_id join groups g on g.id = s.group_id left join threads th on th.id = s.thread_id
      where ${afterId(after, sql`s.id`)} order by s.id limit ${limit}`),
    key: (r) => [r.id],
    count: countOf(sql`stories`),
  },
  items: {
    title: "Items",
    description: "Every fetched article, kept forever: as first stored (title, text, dates) plus the feed and page metadata, how it was fetched, when it was last carried, every feed that carried it and how many headline revisions it has.",
    columns: ["id", "source_id", "source", "group", "run_id", "url", "url_canonical", "title", "text", "published_at", "lang", "lang_detected", "content_hash", "first_seen_at", "last_seen_at", "seen_count", "author", "categories", "image_url", "description", "word_count", "guid", "feed_updated_at", "site_name", "fetch", "feeds", "revisions", "raw"],
    page: (after, limit) => rows(sql`select i.id, i.source_id, src.name as source, g.slug as "group", i.run_id, i.url, i.url_canonical, i.title, i.text, i.published_at, i.lang, i.lang_detected,
        i.content_hash, i.first_seen_at, i.last_seen_at, i.seen_count, i.author, i.categories, i.image_url, i.description, i.word_count, i.guid,
        i.feed_updated_at, i.site_name, i."fetch",
        coalesce((select array_agg(isr.source_id order by isr.source_id) from item_sources isr where isr.item_id = i.id), '{}') as feeds,
        (select count(*)::int from item_revisions r where r.item_id = i.id) as revisions, i.raw
      from items i join sources src on src.id = i.source_id join groups g on g.id = src.group_id
      where ${afterId(after, sql`i.id`)} order by i.id limit ${limit}`),
    key: (r) => [r.id],
    count: countOf(sql`items`),
  },
  item_revisions: {
    title: "Headline revisions",
    description: "Each time the item's own feed carried it with a different headline or text than the latest known one: the new headline and a sha256 of the text as last fetched the way it was first stored (a headline-only change keeps the previous hash).",
    columns: ["id", "item_id", "title", "text_hash", "seen_at"],
    page: (after, limit) => rows(sql`select id, item_id, title, text_hash, seen_at from item_revisions where ${afterId(after, sql`id`)} order by id limit ${limit}`),
    key: (r) => [r.id],
    count: countOf(sql`item_revisions`),
  },
  entities: {
    title: "Entities",
    description: "People, organisations, places and events named by stories. mention_count, first_seen_at and last_seen_at count published stories.",
    columns: ["id", "kind", "slug", "name_en", "name_ur", "aliases", "mention_count", "first_seen_at", "last_seen_at"],
    page: (after, limit) => rows(sql`select id, kind::text as kind, slug, name_en, name_ur, aliases, mention_count, first_seen_at, last_seen_at
      from entities where ${afterId(after, sql`id`)} order by id limit ${limit}`),
    key: (r) => [r.id],
    count: countOf(sql`entities`),
  },
  story_entities: {
    title: "Story ↔ entity links",
    description: "Which story names which entity, with its role in the story and salience (0–1), and whether the story is published.",
    columns: ["story_id", "entity_id", "entity", "role", "salience", "date", "published"],
    page: (after, limit) => rows(sql`select se.story_id, se.entity_id, en.slug as entity, se.role, se.salience, ed.date::text as date, (ed.status = 'published') as published
      from story_entities se join entities en on en.id = se.entity_id join stories s on s.id = se.story_id join editions ed on ed.id = s.edition_id
      where ${after ? sql`(se.story_id, se.entity_id) > (${after[0]}, ${after[1]})` : sql`true`} order by se.story_id, se.entity_id limit ${limit}`),
    key: (r) => [r.story_id, r.entity_id],
    count: countOf(sql`story_entities`),
  },
  search_log: {
    title: "Reader searches",
    description: "Every search a reader ran: the words as typed and normalised, page language, filters and number of results.",
    columns: ["id", "user_id", "q", "q_norm", "locale", "filters", "results", "created_at"],
    page: (after, limit) => rows(sql`select id, user_id, q, q_norm, locale, filters, results, created_at from search_log where ${afterId(after, sql`id`)} order by id limit ${limit}`),
    key: (r) => [r.id],
    count: countOf(sql`search_log`),
  },
};

/** A CSV cell (RFC 4180). Lists and JSON are written as JSON; text a spreadsheet would run as a formula gets a leading '. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d[\d.,]*%?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;
