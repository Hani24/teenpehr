/**
 * Tabayyun database schema (Postgres via Drizzle).
 * Entities follow docs/PLAN.md § "Data model and admin panel". The worker never touches
 * these tables directly; it goes through /api/worker/* (see docs/API.md).
 *
 * Needs the pg_trgm extension and the immutable_array_join() helper before the first table: both
 * come from db/migrations/0000_extensions.sql, which `npm run db:migrate` applies first and
 * `npm run db:push` runs through `db:prepare`.
 */
import {
  pgTable, pgEnum, serial, text, integer, smallint, boolean, timestamp, date, jsonb, numeric, real, customType,
  primaryKey, uniqueIndex, index, check, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  FEEDBACK_REASONS, JOB_KINDS, JOB_STATUSES, MANUAL_PLACEMENTS, QA_STATUSES, REPORT_STATUSES, SOURCE_KINDS, STORY_ORIGINS,
  TRANSLATION_STATUSES, X_LIST_PROPOSAL_STATUSES,
} from "../lib/codes";

/** Full-text vector. Only ever a generated column here, so it is never written, and the site's queries leave it out. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// ---- enums -------------------------------------------------------------------------------
// manual (D12: the inactive source an editor's link is stored under), sitemap and gdelt (D11) came with 0005.
export const sourceKind = pgEnum("source_kind", SOURCE_KINDS);
export const sourceRoute = pgEnum("source_route", ["direct", "germany"]);
export const platform = pgEnum("platform", ["x", "bluesky", "telegram", "youtube"]);
export const handleRole = pgEnum("handle_role", ["outlet", "journalist", "official", "analyst"]);
export const editionSlot = pgEnum("edition_slot", ["subh", "dopahar", "shaam"]);
export const editionStatus = pgEnum("edition_status", ["draft", "review", "published"]);
export const storyTag = pgEnum("story_tag", ["must-read", "worth-knowing", "skim"]);
export const coverage = pgEnum("coverage", ["broad", "partisan", "single-source"]);
// "manual": an editor's story (D12), never AI-verified.
export const qaStatus = pgEnum("qa_status", QA_STATUSES);
export const glossaryKind = pgEnum("glossary_kind", ["person", "place", "org", "other"]);
export const runKind = pgEnum("run_kind", ["edition", "x_collect"]);
// "skipped": the slot was already published or held for review, so the run did nothing billable.
export const runStatus = pgEnum("run_status", ["running", "ok", "failed", "empty", "skipped"]);
/** reader < editor < owner (lib/auth roleAtLeast). There is no public sign-up: every account starts as an invite. */
export const userRole = pgEnum("user_role", ["reader", "editor", "owner"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const inviteKind = pgEnum("invite_kind", ["invite", "reset"]);
export const entityKind = pgEnum("entity_kind", ["person", "org", "place", "event", "other"]);
// "image": one vision check of a story image (D6), its verdict kept so a blurred or dropped picture can be explained.
export const runOutputStage = pgEnum("run_output_stage", ["curate", "urdu", "qa", "image"]);
// Decisions D8–D12 (migration 0005); the value lists live in lib/codes.ts.
export const storyOrigin = pgEnum("story_origin", STORY_ORIGINS);
export const manualPlacement = pgEnum("manual_placement", MANUAL_PLACEMENTS);
export const reportStatus = pgEnum("report_status", REPORT_STATUSES);
export const workerJobKind = pgEnum("worker_job_kind", JOB_KINDS);
export const workerJobStatus = pgEnum("worker_job_status", JOB_STATUSES);
export const translationStatus = pgEnum("translation_status", TRANSLATION_STATUSES);
export const xListProposalStatus = pgEnum("x_list_proposal_status", X_LIST_PROPOSAL_STATUSES);

// ---- configuration (edited in the admin) ------------------------------------------------
export const groups = pgTable("groups", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  nameEn: text("name_en").notNull(),
  nameUr: text("name_ur").notNull(),
  order: integer("order").notNull().default(0),
  brief: text("brief").notNull().default(""),
  storyCount: integer("story_count").notNull().default(7),
  hiddenInThemes: text("hidden_in_themes").array().notNull().default(sql`'{}'::text[]`),
  xListIds: text("x_list_ids").array().notNull().default(sql`'{}'::text[]`),
  active: boolean("active").notNull().default(true),
});

// Published stories reach groups through sources, stories and edition_groups, so those references are
// RESTRICT: a group is retired by setting active=false, never deleted out from under an edition.
export const sources = pgTable("sources", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  kind: sourceKind("kind").notNull().default("rss"),
  url: text("url").notNull(),
  lang: text("lang").notNull().default("en"),
  perspective: text("perspective").notNull().default(""),
  fetcherTier: integer("fetcher_tier").notNull().default(0),
  route: sourceRoute("route").notNull().default("direct"),
  maxItems: integer("max_items").notNull().default(8),
  active: boolean("active").notNull().default(true),
  notes: text("notes").notNull().default(""),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  failStreak: integer("fail_streak").notNull().default(0),
  // Archived sources leave the worker config but keep their rows, so published citations survive.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("sources_group_url").on(t.groupId, t.url)]);

export const handles = pgTable("handles", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  platform: platform("platform").notNull().default("x"),
  handle: text("handle").notNull(),
  displayName: text("display_name").notNull().default(""),
  role: handleRole("role").notNull().default("journalist"),
  active: boolean("active").notNull().default(true),
  lastPostAt: timestamp("last_post_at", { withTimezone: true }),
  fallbackUsedAt: timestamp("fallback_used_at", { withTimezone: true }),
}, (t) => [uniqueIndex("handles_platform_handle").on(t.platform, t.handle)]);

export const topics = pgTable("topics", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  keywordsEn: text("keywords_en").array().notNull().default(sql`'{}'::text[]`),
  keywordsUr: text("keywords_ur").array().notNull().default(sql`'{}'::text[]`),
  boost: integer("boost").notNull().default(1),
});

export const glossary = pgTable("glossary", {
  id: serial("id").primaryKey(),
  termEn: text("term_en").notNull().unique(),
  termUr: text("term_ur").notNull(),
  kind: glossaryKind("kind").notNull().default("other"),
  locked: boolean("locked").notNull().default(false),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

// ---- accounts (docs/PLAN.md decision D2: the whole site is invite-only) -----------------------
// Emails are stored lowercased (checked), so lookups compare with =. Tokens (sessions, invites, feed)
// are stored only as sha256 hex; the raw token lives in the cookie, the invite URL or the feed URL.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  role: userRole("role").notNull().default("reader"),
  status: userStatus("status").notNull().default("active"),
  // lib/auth/password.ts: "scrypt$N$r$p$salt$key". Accepting an invite creates the row with one; null cannot sign in.
  passwordHash: text("password_hash"),
  // reading preferences, validated by lib/auth/prefs.ts (palette, mode, size, contrast, nastaliq, digits, images)
  prefs: jsonb("prefs").$type<Record<string, unknown>>().notNull().default({}),
  feedTokenHash: text("feed_token_hash").unique(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  lastVisitAt: timestamp("last_visit_at", { withTimezone: true }),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  invitedBy: integer("invited_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("users_email_lower", sql`${t.email} = lower(${t.email})`)]);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256 hex of the raw cookie token
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  userAgent: text("user_agent").notNull().default(""),
  ip: text("ip").notNull().default(""),
}, (t) => [index("sessions_user").on(t.userId), index("sessions_expires").on(t.expiresAt)]);

/** Single-use links: an invite creates the account, a reset sets a new password. */
export const invites = pgTable("invites", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  kind: inviteKind("kind").notNull().default("invite"),
  email: text("email").notNull(),
  role: userRole("role").notNull().default("reader"),
  // null for the first owner, invited from the command line (npm run user:invite)
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedBy: integer("used_by").references(() => users.id, { onDelete: "set null" }),
}, (t) => [index("invites_email").on(t.email), check("invites_email_lower", sql`${t.email} = lower(${t.email})`)]);

/** Every sign-in attempt, kept for the rate limit (lib/auth/rate-limit.ts) and for audit. */
export const loginAttempts = pgTable("login_attempts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  ip: text("ip").notNull().default(""),
  ok: boolean("ok").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("login_attempts_email_at").on(t.email, t.at), index("login_attempts_ip_at").on(t.ip, t.at),
  check("login_attempts_email_lower", sql`${t.email} = lower(${t.email})`),
]);

// ---- raw material (written by the worker) -------------------------------------------------
export const runs = pgTable("runs", {
  id: serial("id").primaryKey(),
  kind: runKind("kind").notNull(),
  date: date("date"),
  slot: editionSlot("slot"),
  status: runStatus("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  model: text("model"),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
  log: text("log").notNull().default(""),
  error: text("error"),
});

export const runSources = pgTable("run_sources", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  sourceId: integer("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  ok: boolean("ok").notNull(),
  items: integer("items").notNull().default(0),
  error: text("error"),
  ms: integer("ms").notNull().default(0),
  tier: integer("tier").notNull().default(0),
  route: sourceRoute("route").notNull().default("direct"),
});

/** Which items an edition run fed to each group's curation, and whether that run stored them first. */
export const runItems = pgTable("run_items", {
  runId: integer("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "restrict" }),
  isNew: boolean("is_new").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.runId, t.itemId, t.groupId] }), index("run_items_item").on(t.itemId)]);

/** Each Claude call's structured output, kept so an edition can be audited and prompts compared later. */
export const runOutputs = pgTable("run_outputs", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  groupId: integer("group_id").references(() => groups.id, { onDelete: "restrict" }), // null: a call that covers every group
  stage: runOutputStage("stage").notNull(),
  model: text("model").notNull().default(""),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  output: jsonb("output").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("run_outputs_run").on(t.runId, t.stage)]);

/** How the worker fetched an item (POST /api/worker/items `fetch`). */
export type ItemFetch = { route?: "direct" | "germany"; tier?: number; status?: number; ms?: number; via?: string };

// Citations must never disappear from a published edition, so the rows they point at are
// ON DELETE RESTRICT (items→sources, story_sources→items, story_posts→posts, run_sources→sources).
// Retire a source by setting sources.archived_at instead of deleting it. Items are kept forever
// (decision D5): they are the record of what every edition was written from, and the corpus for
// trend analysis and search.
export const items = pgTable("items", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
  url: text("url").notNull(),
  urlCanonical: text("url_canonical").notNull().unique(),
  title: text("title").notNull(),
  text: text("text").notNull().default(""),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  lang: text("lang").notNull().default("en"),
  contentHash: text("content_hash").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  // Feed metadata, all optional in POST /api/worker/items and, like title and text, as first stored.
  author: text("author"),
  categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
  imageUrl: text("image_url"),
  description: text("description"),
  wordCount: integer("word_count"),
  langDetected: text("lang_detected"),
  guid: text("guid"),
  feedUpdatedAt: timestamp("feed_updated_at", { withTimezone: true }),
  siteName: text("site_name"),
  // Bumped whenever a POST /items carries the item again: max(item_sources.last_seen_at), and how many requests saw it.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  seenCount: integer("seen_count").notNull().default(1),
  fetch: jsonb("fetch").$type<ItemFetch>(),
  raw: jsonb("raw").$type<Record<string, unknown>>(), // size-capped subset of the feed entry
  // 'simple' (no stemming): items come in English, Urdu and other languages. Title outranks text.
  search: tsvector("search").generatedAlwaysAs(sql`setweight(to_tsvector('simple'::regconfig, "title"), 'A') || setweight(to_tsvector('simple'::regconfig, "text"), 'D')`),
}, (t) => [
  index("items_source_seen").on(t.sourceId, t.firstSeenAt), index("items_published").on(t.publishedAt),
  index("items_search").using("gin", t.search),
]);

/**
 * Every feed an item was seen in. items.source_id is only the feed that stored it first; an article
 * carried by feeds of several groups gets one row here per feed, so a feed that answers 304 can read
 * its items back (GET /api/worker/items) and "which outlets carried this" is a query.
 */
export const itemSources = pgTable("item_sources", {
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  sourceId: integer("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.itemId, t.sourceId] }), index("item_sources_source_seen").on(t.sourceId, t.lastSeenAt)]);

/**
 * Headline history. items keeps the title and text as first stored (a published story cites what the
 * agent saw); a row lands here each time a feed carries the item with a different title or text.
 */
export const itemRevisions = pgTable("item_revisions", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  textHash: text("text_hash").notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("item_revisions_item").on(t.itemId, t.seenAt)]);

export type PostMetrics = { replies?: number; reposts?: number; likes?: number; quotes?: number; views?: number; bookmarks?: number };
export type PostMedia = { type: "photo" | "video" | "gif" | "other"; url: string; preview_url?: string; alt?: string };

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  handleId: integer("handle_id").references(() => handles.id, { onDelete: "set null" }),
  platform: platform("platform").notNull().default("x"),
  platformId: text("platform_id").notNull(),
  authorHandle: text("author_handle").notNull(),
  authorName: text("author_name").notNull().default(""),
  text: text("text").notNull(),
  url: text("url").notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
  isRepost: boolean("is_repost").notNull().default(false),
  raw: jsonb("raw"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  // Metadata, all optional in POST /api/worker/posts. metrics change on every collection; the rest are as posted.
  lang: text("lang"),
  metrics: jsonb("metrics").$type<PostMetrics>(),
  hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
  mentions: text("mentions").array().notNull().default(sql`'{}'::text[]`),
  urls: text("urls").array().notNull().default(sql`'{}'::text[]`),
  media: jsonb("media").$type<PostMedia[]>(),
  inReplyTo: text("in_reply_to"), // platform id of the parent post
  conversationId: text("conversation_id"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("posts_platform_id").on(t.platform, t.platformId), index("posts_posted").on(t.postedAt),
  // The X board (D10) reads each group's handles' recent posts.
  index("posts_handle_posted").on(t.handleId, t.postedAt),
]);

// ---- editorial output ---------------------------------------------------------------------
export const threads = pgTable("threads", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  titleEn: text("title_en").notNull(),
  titleUr: text("title_ur").notNull().default(""),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
});

export const editions = pgTable("editions", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  slot: editionSlot("slot").notNull(),
  status: editionStatus("status").notNull().default("draft"),
  runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  snapshotPath: text("snapshot_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("editions_date_slot").on(t.date, t.slot)]);

export const editionGroups = pgTable("edition_groups", {
  id: serial("id").primaryKey(),
  editionId: integer("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "restrict" }),
  order: integer("order").notNull().default(0),
  leadEn: text("lead_en").notNull().default(""),
  leadUr: text("lead_ur").notNull().default(""),
  itemCount: integer("item_count").notNull().default(0),
}, (t) => [uniqueIndex("edition_groups_unique").on(t.editionId, t.groupId)]);

export type Angle = { itemId: number; noteEn: string; noteUr: string };

/**
 * One re-encoded size of an image, stored as MEDIA_DIR/<file> and served to signed-in readers at
 * /media/<file> (lib/media.ts builds the URLs, lib/media-store.ts writes and reads the files).
 * `file` is `<sha256>-<w>.webp`; `bytes` is the size of that file on disk.
 */
export type ImageVariant = { w: number; h: number; file: string; bytes: number; mime: "image/webp" };

/**
 * Publisher images shown on stories (POST /api/worker/images, docs/API.md). Only the image of an item
 * or post a story cites, so each row belongs to exactly one item or one post and carries that outlet's
 * credit: the same picture used by two outlets is two rows over the same files, and one upload is
 * idempotent per (sha256, item) or (sha256, post). `sha256` is the SHA-256 of the image as downloaded from
 * the publisher, and names its files (content-addressed, `<sha256>-<w>.webp` under MEDIA_DIR). `alt` is the
 * publisher's own text (og:image:alt, media description) or null, never written by a model; the reader
 * pages fall back to "Image from <credit>". `graphic` comes from the worker's vision check and is true
 * whenever that check did not answer (fail safe). Never deleted while a story uses it (stories.image_id is
 * RESTRICT), and it keeps its item or post (RESTRICT) like a citation. Editions published before images
 * existed are not back-filled.
 */
export const images = pgTable("images", {
  id: serial("id").primaryKey(),
  sha256: text("sha256").notNull(),
  sourceUrl: text("source_url").notNull(), // where the worker downloaded it; never shown or linked to readers
  itemId: integer("item_id").references(() => items.id, { onDelete: "restrict" }),
  postId: integer("post_id").references(() => posts.id, { onDelete: "restrict" }),
  sourceId: integer("source_id").references(() => sources.id, { onDelete: "restrict" }), // the item's feed; null for posts
  credit: text("credit").notNull(), // the outlet's name as the story shows it
  alt: text("alt"),
  width: integer("width").notNull(), // the downloaded image's own size
  height: integer("height").notNull(),
  color: text("color").notNull(), // dominant colour, "#rrggbb": the placeholder while the file loads
  graphic: boolean("graphic").notNull().default(true),
  variants: jsonb("variants").$type<ImageVariant[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("images_sha256_item").on(t.sha256, t.itemId).where(sql`${t.itemId} is not null`),
  uniqueIndex("images_sha256_post").on(t.sha256, t.postId).where(sql`${t.postId} is not null`),
  check("images_one_owner", sql`num_nonnulls(${t.itemId}, ${t.postId}) = 1`),
  check("images_sha256_hex", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check("images_color_hex", sql`${t.color} ~ '^#[0-9a-f]{6}$'`),
  check("images_size", sql`${t.width} > 0 and ${t.height} > 0`),
  check("images_credit", sql`${t.credit} <> ''`),
  check("images_variants", sql`case when jsonb_typeof(${t.variants}) = 'array' then jsonb_array_length(${t.variants}) between 1 and 2 else false end`),
]);

export const stories = pgTable("stories", {
  id: serial("id").primaryKey(),
  editionId: integer("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "restrict" }),
  threadId: integer("thread_id").references(() => threads.id, { onDelete: "set null" }),
  order: integer("order").notNull().default(0),
  titleEn: text("title_en").notNull(),
  titleUr: text("title_ur").notNull().default(""),
  summaryEn: text("summary_en").notNull(),
  summaryUr: text("summary_ur").notNull().default(""),
  whyEn: text("why_en").notNull().default(""),
  whyUr: text("why_ur").notNull().default(""),
  tag: storyTag("tag").notNull().default("worth-knowing"),
  coverage: coverage("coverage"),
  contestedEn: text("contested_en").notNull().default(""),
  contestedUr: text("contested_ur").notNull().default(""),
  angles: jsonb("angles").$type<Angle[]>().notNull().default([]),
  qaStatus: qaStatus("qa_status").notNull().default("pending"),
  qaNote: text("qa_note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Research metadata from curation (all optional in the edition PUT); slugs from lib/taxonomy.ts.
  keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
  topics: text("topics").array().notNull().default(sql`'{}'::text[]`),
  countries: text("countries").array().notNull().default(sql`'{}'::text[]`), // ISO 3166-1 alpha-2, upper case
  places: text("places").array().notNull().default(sql`'{}'::text[]`),
  eventType: text("event_type"),
  wordCount: integer("word_count"),
  readingTimeSec: integer("reading_time_sec"),
  // The publisher image shown with the story (edition PUT `image_id`): the image of one of the story's own
  // cited items or posts. An editor can hide it, on a published story too (the story text stays as
  // published): image_hidden_at/by record when and who, like a correction. Hidden means readers never see it.
  imageId: integer("image_id").references(() => images.id, { onDelete: "restrict" }),
  imageHiddenAt: timestamp("image_hidden_at", { withTimezone: true }),
  imageHiddenBy: integer("image_hidden_by").references(() => users.id, { onDelete: "set null" }),
  // Manual entries (D12). `origin` says who wrote the story; an editor's is `manual`, with qa_status
  // `manual`, a `placement`, and a byline snapshot (created_by_name, so "added by <name>" never changes
  // after publication). `language_filled` names the side the worker wrote from the editor's text
  // (fill_language job), null when the editor wrote both. `desk_at`: when a `desk` story went live on
  // the Editor's desk strip; from then on it is immutable like a published story, and it joins the next
  // edition that publishes (lib/desk.ts). A desk story still lives in an unpublished edition row, so
  // edition_id stays NOT NULL and every reader query keeps its shape.
  origin: storyOrigin("origin").notNull().default("ai"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdByName: text("created_by_name").notNull().default(""),
  languageFilled: text("language_filled").$type<"en" | "ur">(),
  placement: manualPlacement("placement"),
  deskAt: timestamp("desk_at", { withTimezone: true }),
  // Editorial review (D14): every edition publishes without waiting for an editor, and each story shows
  // readers whether one has reviewed it. Metadata only, never the story's text (which stays as published):
  // reviewed_at/by when an editor marked it reviewed (an owner may undo it). withdrawn_at/by and the note
  // (English and/or Urdu, one required) when the editors withdrew it: it leaves every reader list, and its
  // address shows only that it was withdrawn, why and when (an owner may undo it). Who did what is also
  // in audit_log. Stories published before D14 stay "not reviewed" (null).
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: integer("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawnBy: integer("withdrawn_by").references(() => users.id, { onDelete: "set null" }),
  withdrawNoteEn: text("withdraw_note_en").notNull().default(""),
  withdrawNoteUr: text("withdraw_note_ur").notNull().default(""),
  // Full-text search. English is stemmed; Urdu has no Postgres dictionary, so 'simple'. Arrays go through
  // immutable_array_join() (db/migrations/0000_extensions.sql): array_to_string() is only STABLE.
  searchEn: tsvector("search_en").generatedAlwaysAs(sql`setweight(to_tsvector('english'::regconfig, "title_en"), 'A') || setweight(to_tsvector('english'::regconfig, immutable_array_join("keywords")), 'B') || setweight(to_tsvector('english'::regconfig, "summary_en"), 'B') || setweight(to_tsvector('english'::regconfig, "why_en" || ' ' || "contested_en"), 'C')`),
  searchUr: tsvector("search_ur").generatedAlwaysAs(sql`setweight(to_tsvector('simple'::regconfig, "title_ur"), 'A') || setweight(to_tsvector('simple'::regconfig, "summary_ur"), 'B') || setweight(to_tsvector('simple'::regconfig, "why_ur" || ' ' || "contested_ur"), 'C')`),
}, (t) => [
  index("stories_edition").on(t.editionId, t.groupId, t.order), index("stories_thread").on(t.threadId),
  index("stories_search_en").using("gin", t.searchEn), index("stories_search_ur").using("gin", t.searchUr),
  index("stories_title_en_trgm").using("gin", t.titleEn.op("gin_trgm_ops")), index("stories_title_ur_trgm").using("gin", t.titleUr.op("gin_trgm_ops")),
  index("stories_topics").using("gin", t.topics), index("stories_countries").using("gin", t.countries),
  // /media asks which stories show an image (app/media/[file]/route.ts); also serves the images FK checks.
  index("stories_image").on(t.imageId).where(sql`${t.imageId} is not null`),
  // The front page's Editor's desk strip (lib/desk.ts getDeskStories).
  index("stories_desk").on(t.deskAt).where(sql`${t.deskAt} is not null`),
  // The admin's Review page and counts (D14): stories no editor has reviewed yet, not withdrawn.
  index("stories_unreviewed").on(t.editionId).where(sql`${t.reviewedAt} is null and ${t.withdrawnAt} is null`),
  check("stories_reviewed_by", sql`${t.reviewedBy} is null or ${t.reviewedAt} is not null`),
  check("stories_withdrawn_by", sql`${t.withdrawnBy} is null or ${t.withdrawnAt} is not null`),
  check("stories_withdraw_note", sql`${t.withdrawnAt} is null or btrim(${t.withdrawNoteEn}) <> '' or btrim(${t.withdrawNoteUr}) <> ''`),
  check("stories_manual_placement", sql`(${t.origin} = 'manual') = (${t.placement} is not null)`),
  check("stories_desk_at", sql`${t.deskAt} is null or ${t.placement} = 'desk'`),
  check("stories_language_filled", sql`${t.languageFilled} is null or (${t.languageFilled} in ('en', 'ur') and ${t.origin} = 'manual')`),
]);

export const storySources = pgTable("story_sources", {
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  isPrimary: boolean("is_primary").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.storyId, t.itemId] })]);

export const storyPosts = pgTable("story_posts", {
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  postId: integer("post_id").notNull().references(() => posts.id, { onDelete: "restrict" }),
}, (t) => [primaryKey({ columns: [t.storyId, t.postId] })]);

export const corrections = pgTable("corrections", {
  id: serial("id").primaryKey(),
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  textEn: text("text_en").notNull(),
  textUr: text("text_ur").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** People, organisations, places and events named by stories, across editions. */
export const entities = pgTable("entities", {
  id: serial("id").primaryKey(),
  kind: entityKind("kind").notNull().default("other"),
  slug: text("slug").notNull().unique(),
  nameEn: text("name_en").notNull(),
  nameUr: text("name_ur").notNull().default(""),
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  mentionCount: integer("mention_count").notNull().default(0),
}, (t) => [
  index("entities_name_en_trgm").using("gin", t.nameEn.op("gin_trgm_ops")), index("entities_name_ur_trgm").using("gin", t.nameUr.op("gin_trgm_ops")),
]);

/** A story's entities go with the story (a draft rewrite replaces them); an entity in use is never deleted. */
export const storyEntities = pgTable("story_entities", {
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  entityId: integer("entity_id").notNull().references(() => entities.id, { onDelete: "restrict" }),
  role: text("role").notNull().default(""),
  salience: real("salience"),
}, (t) => [primaryKey({ columns: [t.storyId, t.entityId] }), index("story_entities_entity").on(t.entityId)]);

// ---- readers ------------------------------------------------------------------------------
// A reader's rows go when the account is deleted; published stories and editions are never
// deleted, so the references to them are RESTRICT.
export const savedStories = pgTable("saved_stories", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  note: text("note").notNull().default(""),
}, (t) => [primaryKey({ columns: [t.userId, t.storyId] }), index("saved_stories_story").on(t.storyId)]);

export const savedEditions = pgTable("saved_editions", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  editionId: integer("edition_id").notNull().references(() => editions.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.editionId] }), index("saved_editions_edition").on(t.editionId)]);

export const storyReads = pgTable("story_reads", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "restrict" }),
  firstReadAt: timestamp("first_read_at", { withTimezone: true }).notNull().defaultNow(),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  count: integer("count").notNull().default(1),
}, (t) => [primaryKey({ columns: [t.userId, t.storyId] }), index("story_reads_story").on(t.storyId)]);

/** Reader searches, for tuning search and for topic research. q_norm: lowercased, NFC, spaces collapsed. */
export const searchLog = pgTable("search_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  q: text("q").notNull(),
  qNorm: text("q_norm").notNull(),
  locale: text("locale").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
  results: integer("results").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("search_log_created").on(t.createdAt), index("search_log_q_norm").on(t.qNorm)]);

/**
 * Relevance feedback (D8): one vote per reader per story, changed in place or deleted. 1 is "Relevant to
 * me", -1 "Show less like this" (optional reasons from lib/codes.ts FEEDBACK_REASONS, only on -1). For
 * insights and a later "For you" ordering that may reweight topics and groups only: never used to hide a
 * story from the shared edition or to drop an outlet's perspective.
 */
export const storyFeedback = pgTable("story_feedback", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "restrict" }),
  value: smallint("value").notNull(),
  reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.storyId] }), index("story_feedback_story").on(t.storyId),
  index("story_feedback_updated").on(t.updatedAt),
  check("story_feedback_value", sql`${t.value} in (-1, 1)`),
  check("story_feedback_reasons", sql`${t.reasons} <@ ${sql.raw(`array[${FEEDBACK_REASONS.map((r) => `'${r}'`).join(", ")}]::text[]`)} and (${t.value} = -1 or cardinality(${t.reasons}) = 0)`),
]);

/** "Report a mistake" (D8): a reader's free text to the editors' queue. Not a vote. */
export const storyReports = pgTable("story_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "restrict" }),
  text: text("text").notNull(),
  locale: text("locale").notNull().default("en"), // the language the reader was reading in
  status: reportStatus("status").notNull().default("open"),
  note: text("note").notNull().default(""), // the editor's resolution note
  resolvedBy: integer("resolved_by").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("story_reports_status").on(t.status, t.createdAt), index("story_reports_story").on(t.storyId),
  check("story_reports_text", sql`char_length(${t.text}) between 1 and 2000`),
  check("story_reports_locale", sql`${t.locale} in ('en', 'ur')`),
]);

// ---- worker jobs (docs/API.md § Jobs) -------------------------------------------------------
/**
 * Work the site asks of the worker between editions: a full-article Urdu translation (D9), filling a
 * manual story's missing language (D12), a manual story's image from its link (D12). The worker claims
 * one with POST /api/worker/jobs/claim (FOR UPDATE SKIP LOCKED, a lease in locked_until; an expired lease
 * is claimable again and every claim counts an attempt) and reports done or fail; lib/jobs.ts enqueues
 * and applies results. `dedupe_key` (unique when set) makes a repeated request find the job it already
 * made. `payload` and `result` are validated per kind by lib/contracts.ts.
 */
export const workerJobs = pgTable("worker_jobs", {
  id: serial("id").primaryKey(),
  kind: workerJobKind("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  dedupeKey: text("dedupe_key").unique(),
  status: workerJobStatus("status").notNull().default("queued"),
  priority: integer("priority").notNull().default(0), // higher first
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(), // a retry's backoff
  lockedBy: text("locked_by"),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  requestedBy: integer("requested_by").references(() => users.id, { onDelete: "set null" }),
  result: jsonb("result").$type<Record<string, unknown>>(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("worker_jobs_claim").on(t.kind, t.priority, t.id).where(sql`${t.status} in ('queued', 'running')`),
  // Per-reader daily limits (D9) count the jobs a reader's requests made.
  index("worker_jobs_requested").on(t.requestedBy, t.kind, t.createdAt).where(sql`${t.requestedBy} is not null`),
  check("worker_jobs_attempts", sql`${t.attempts} >= 0 and ${t.maxAttempts} between 1 and 20`),
]);

/**
 * Full Urdu translations of cited articles, made on a reader's request (D9) and kept for every later
 * reader. One row per (item, lang); only Urdu for now. Shown only to signed-in readers on its own page,
 * labelled as an AI translation of the outlet's article; never in feeds, downloads, search or the X board.
 * `status` follows its job; `blocked` (paywalled, robots.txt, unreachable, …) is final and says why in
 * `blocked_reason` (lib/codes.ts TRANSLATION_BLOCK_REASONS). The item row RESTRICTs, like a citation.
 */
export const articleTranslations = pgTable("article_translations", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  lang: text("lang").notNull().default("ur"),
  status: translationStatus("status").notNull().default("queued"),
  title: text("title"),
  body: text("body"),
  sourceTextHash: text("source_text_hash"), // sha256 hex of the extracted full text that was translated
  sourceWords: integer("source_words"),
  model: text("model"),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  checkOk: boolean("check_ok"), // the faithfulness check (numbers, names, quotes, nothing added or dropped)
  checkNote: text("check_note"),
  jobId: integer("job_id").references(() => workerJobs.id, { onDelete: "set null" }),
  requestedBy: integer("requested_by").references(() => users.id, { onDelete: "set null" }), // the first reader who asked
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
  blockedReason: text("blocked_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("article_translations_item_lang").on(t.itemId, t.lang),
  index("article_translations_status").on(t.status, t.requestedAt),
  check("article_translations_lang", sql`${t.lang} = 'ur'`),
]);

// ---- editorial bookkeeping ----------------------------------------------------------------
/**
 * Existing public X Lists proposed for a group (D10), found and verified live by the research step
 * (syndication list endpoint). Never applied automatically: an owner's "Add to group" appends list_id to
 * groups.x_list_ids and marks the row `added`.
 */
export const xListProposals = pgTable("x_list_proposals", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  listId: text("list_id").notNull(),
  name: text("name").notNull().default(""),
  ownerHandle: text("owner_handle").notNull().default(""),
  url: text("url"),
  memberCount: integer("member_count"),
  sampleHandles: text("sample_handles").array().notNull().default(sql`'{}'::text[]`),
  postsSeen: integer("posts_seen"), // entries the syndication endpoint returned at verification
  newestPostAt: timestamp("newest_post_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  note: text("note").notNull().default(""), // why it fits the group, what to watch out for
  status: xListProposalStatus("status").notNull().default("proposed"),
  decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("x_list_proposals_group_list").on(t.groupId, t.listId),
  check("x_list_proposals_list_id", sql`${t.listId} ~ '^[0-9]{1,25}$'`),
]);

/**
 * Who did what in the admin, for actions worth a record (manual stories, report decisions, X List
 * approvals, source activation). `target` is "<table>:<id>" or similar; `detail` is small JSON.
 */
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target").notNull().default(""),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("audit_log_at").on(t.at), index("audit_log_target").on(t.target)]);

// ---- relations (for db.query.*) -----------------------------------------------------------
export const groupsRelations = relations(groups, ({ many }) => ({ sources: many(sources), handles: many(handles), topics: many(topics) }));
export const sourcesRelations = relations(sources, ({ one, many }) => ({ group: one(groups, { fields: [sources.groupId], references: [groups.id] }), items: many(items) }));
export const handlesRelations = relations(handles, ({ one }) => ({ group: one(groups, { fields: [handles.groupId], references: [groups.id] }) }));
export const itemsRelations = relations(items, ({ one, many }) => ({ source: one(sources, { fields: [items.sourceId], references: [sources.id] }), sightings: many(itemSources), revisions: many(itemRevisions) }));
export const itemRevisionsRelations = relations(itemRevisions, ({ one }) => ({ item: one(items, { fields: [itemRevisions.itemId], references: [items.id] }) }));
export const itemSourcesRelations = relations(itemSources, ({ one }) => ({ item: one(items, { fields: [itemSources.itemId], references: [items.id] }), source: one(sources, { fields: [itemSources.sourceId], references: [sources.id] }) }));
export const postsRelations = relations(posts, ({ one }) => ({ handle: one(handles, { fields: [posts.handleId], references: [handles.id] }) }));
export const editionsRelations = relations(editions, ({ many, one }) => ({ groups: many(editionGroups), stories: many(stories), run: one(runs, { fields: [editions.runId], references: [runs.id] }) }));
export const editionGroupsRelations = relations(editionGroups, ({ one }) => ({ edition: one(editions, { fields: [editionGroups.editionId], references: [editions.id] }), group: one(groups, { fields: [editionGroups.groupId], references: [groups.id] }) }));
export const storiesRelations = relations(stories, ({ one, many }) => ({
  edition: one(editions, { fields: [stories.editionId], references: [editions.id] }),
  group: one(groups, { fields: [stories.groupId], references: [groups.id] }),
  thread: one(threads, { fields: [stories.threadId], references: [threads.id] }),
  image: one(images, { fields: [stories.imageId], references: [images.id] }),
  imageHider: one(users, { fields: [stories.imageHiddenBy], references: [users.id] }),
  creator: one(users, { fields: [stories.createdBy], references: [users.id] }),
  reviewer: one(users, { fields: [stories.reviewedBy], references: [users.id] }),
  withdrawer: one(users, { fields: [stories.withdrawnBy], references: [users.id] }),
  sources: many(storySources), posts: many(storyPosts), corrections: many(corrections), entities: many(storyEntities),
  feedback: many(storyFeedback), reports: many(storyReports),
}));
export const imagesRelations = relations(images, ({ one, many }) => ({
  item: one(items, { fields: [images.itemId], references: [items.id] }),
  post: one(posts, { fields: [images.postId], references: [posts.id] }),
  source: one(sources, { fields: [images.sourceId], references: [sources.id] }),
  stories: many(stories),
}));
export const storySourcesRelations = relations(storySources, ({ one }) => ({ story: one(stories, { fields: [storySources.storyId], references: [stories.id] }), item: one(items, { fields: [storySources.itemId], references: [items.id] }) }));
export const storyPostsRelations = relations(storyPosts, ({ one }) => ({ story: one(stories, { fields: [storyPosts.storyId], references: [stories.id] }), post: one(posts, { fields: [storyPosts.postId], references: [posts.id] }) }));
export const threadsRelations = relations(threads, ({ many }) => ({ stories: many(stories) }));
export const runsRelations = relations(runs, ({ many }) => ({ sources: many(runSources), items: many(runItems), outputs: many(runOutputs) }));
export const runItemsRelations = relations(runItems, ({ one }) => ({ run: one(runs, { fields: [runItems.runId], references: [runs.id] }), item: one(items, { fields: [runItems.itemId], references: [items.id] }), group: one(groups, { fields: [runItems.groupId], references: [groups.id] }) }));
export const runOutputsRelations = relations(runOutputs, ({ one }) => ({ run: one(runs, { fields: [runOutputs.runId], references: [runs.id] }), group: one(groups, { fields: [runOutputs.groupId], references: [groups.id] }) }));
export const runSourcesRelations = relations(runSources, ({ one }) => ({ run: one(runs, { fields: [runSources.runId], references: [runs.id] }), source: one(sources, { fields: [runSources.sourceId], references: [sources.id] }) }));
export const correctionsRelations = relations(corrections, ({ one }) => ({ story: one(stories, { fields: [corrections.storyId], references: [stories.id] }) }));
export const topicsRelations = relations(topics, ({ one }) => ({ group: one(groups, { fields: [topics.groupId], references: [groups.id] }) }));
export const entitiesRelations = relations(entities, ({ many }) => ({ stories: many(storyEntities) }));
export const storyEntitiesRelations = relations(storyEntities, ({ one }) => ({ story: one(stories, { fields: [storyEntities.storyId], references: [stories.id] }), entity: one(entities, { fields: [storyEntities.entityId], references: [entities.id] }) }));
export const usersRelations = relations(users, ({ many }) => ({ sessions: many(sessions), savedStories: many(savedStories), savedEditions: many(savedEditions), reads: many(storyReads) }));
export const sessionsRelations = relations(sessions, ({ one }) => ({ user: one(users, { fields: [sessions.userId], references: [users.id] }) }));
export const savedStoriesRelations = relations(savedStories, ({ one }) => ({ user: one(users, { fields: [savedStories.userId], references: [users.id] }), story: one(stories, { fields: [savedStories.storyId], references: [stories.id] }) }));
export const savedEditionsRelations = relations(savedEditions, ({ one }) => ({ user: one(users, { fields: [savedEditions.userId], references: [users.id] }), edition: one(editions, { fields: [savedEditions.editionId], references: [editions.id] }) }));
export const storyReadsRelations = relations(storyReads, ({ one }) => ({ user: one(users, { fields: [storyReads.userId], references: [users.id] }), story: one(stories, { fields: [storyReads.storyId], references: [stories.id] }) }));
export const storyFeedbackRelations = relations(storyFeedback, ({ one }) => ({ user: one(users, { fields: [storyFeedback.userId], references: [users.id] }), story: one(stories, { fields: [storyFeedback.storyId], references: [stories.id] }) }));
export const storyReportsRelations = relations(storyReports, ({ one }) => ({
  user: one(users, { fields: [storyReports.userId], references: [users.id] }),
  resolver: one(users, { fields: [storyReports.resolvedBy], references: [users.id] }),
  story: one(stories, { fields: [storyReports.storyId], references: [stories.id] }),
}));
export const workerJobsRelations = relations(workerJobs, ({ one }) => ({ requester: one(users, { fields: [workerJobs.requestedBy], references: [users.id] }) }));
export const articleTranslationsRelations = relations(articleTranslations, ({ one }) => ({
  item: one(items, { fields: [articleTranslations.itemId], references: [items.id] }),
  job: one(workerJobs, { fields: [articleTranslations.jobId], references: [workerJobs.id] }),
  requester: one(users, { fields: [articleTranslations.requestedBy], references: [users.id] }),
}));
export const xListProposalsRelations = relations(xListProposals, ({ one }) => ({
  group: one(groups, { fields: [xListProposals.groupId], references: [groups.id] }),
  decider: one(users, { fields: [xListProposals.decidedBy], references: [users.id] }),
}));
export const auditLogRelations = relations(auditLog, ({ one }) => ({ user: one(users, { fields: [auditLog.userId], references: [users.id] }) }));
