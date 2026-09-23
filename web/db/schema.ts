/**
 * Teen Pehr database schema (Postgres via Drizzle).
 * Entities follow docs/PLAN.md § "Data model and admin panel". The worker never touches
 * these tables directly; it goes through /api/worker/* (see docs/API.md).
 */
import {
  pgTable, pgEnum, serial, text, integer, boolean, timestamp, date, jsonb, numeric,
  primaryKey, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ---- enums -------------------------------------------------------------------------------
export const sourceKind = pgEnum("source_kind", ["rss", "html", "gnews", "youtube", "telegram"]);
export const sourceRoute = pgEnum("source_route", ["direct", "germany"]);
export const platform = pgEnum("platform", ["x", "bluesky", "telegram", "youtube"]);
export const handleRole = pgEnum("handle_role", ["outlet", "journalist", "official", "analyst"]);
export const editionSlot = pgEnum("edition_slot", ["subh", "dopahar", "shaam"]);
export const editionStatus = pgEnum("edition_status", ["draft", "review", "published"]);
export const storyTag = pgEnum("story_tag", ["must-read", "worth-knowing", "skim"]);
export const coverage = pgEnum("coverage", ["broad", "partisan", "single-source"]);
export const qaStatus = pgEnum("qa_status", ["pending", "verified", "flagged"]);
export const glossaryKind = pgEnum("glossary_kind", ["person", "place", "org", "other"]);
export const runKind = pgEnum("run_kind", ["edition", "x_collect"]);
export const runStatus = pgEnum("run_status", ["running", "ok", "failed", "empty"]);
export const adminRole = pgEnum("admin_role", ["owner", "editor"]);

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

export const sources = pgTable("sources", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
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

export const adminUsers = pgTable("admin_users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  role: adminRole("role").notNull().default("editor"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  sourceId: integer("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  ok: boolean("ok").notNull(),
  items: integer("items").notNull().default(0),
  error: text("error"),
  ms: integer("ms").notNull().default(0),
  tier: integer("tier").notNull().default(0),
  route: sourceRoute("route").notNull().default("direct"),
});

export const items = pgTable("items", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
  url: text("url").notNull(),
  urlCanonical: text("url_canonical").notNull().unique(),
  title: text("title").notNull(),
  text: text("text").notNull().default(""),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  lang: text("lang").notNull().default("en"),
  contentHash: text("content_hash").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("items_source_seen").on(t.sourceId, t.firstSeenAt), index("items_published").on(t.publishedAt)]);

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
}, (t) => [uniqueIndex("posts_platform_id").on(t.platform, t.platformId), index("posts_posted").on(t.postedAt)]);

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
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  order: integer("order").notNull().default(0),
  leadEn: text("lead_en").notNull().default(""),
  leadUr: text("lead_ur").notNull().default(""),
  itemCount: integer("item_count").notNull().default(0),
}, (t) => [uniqueIndex("edition_groups_unique").on(t.editionId, t.groupId)]);

export type Angle = { itemId: number; noteEn: string; noteUr: string };

export const stories = pgTable("stories", {
  id: serial("id").primaryKey(),
  editionId: integer("edition_id").notNull().references(() => editions.id, { onDelete: "cascade" }),
  groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
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
}, (t) => [index("stories_edition").on(t.editionId, t.groupId, t.order), index("stories_thread").on(t.threadId)]);

export const storySources = pgTable("story_sources", {
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  isPrimary: boolean("is_primary").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.storyId, t.itemId] })]);

export const storyPosts = pgTable("story_posts", {
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  postId: integer("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.storyId, t.postId] })]);

export const corrections = pgTable("corrections", {
  id: serial("id").primaryKey(),
  storyId: integer("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  textEn: text("text_en").notNull(),
  textUr: text("text_ur").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- relations (for db.query.*) -----------------------------------------------------------
export const groupsRelations = relations(groups, ({ many }) => ({ sources: many(sources), handles: many(handles), topics: many(topics) }));
export const sourcesRelations = relations(sources, ({ one, many }) => ({ group: one(groups, { fields: [sources.groupId], references: [groups.id] }), items: many(items) }));
export const handlesRelations = relations(handles, ({ one }) => ({ group: one(groups, { fields: [handles.groupId], references: [groups.id] }) }));
export const itemsRelations = relations(items, ({ one }) => ({ source: one(sources, { fields: [items.sourceId], references: [sources.id] }) }));
export const postsRelations = relations(posts, ({ one }) => ({ handle: one(handles, { fields: [posts.handleId], references: [handles.id] }) }));
export const editionsRelations = relations(editions, ({ many, one }) => ({ groups: many(editionGroups), stories: many(stories), run: one(runs, { fields: [editions.runId], references: [runs.id] }) }));
export const editionGroupsRelations = relations(editionGroups, ({ one }) => ({ edition: one(editions, { fields: [editionGroups.editionId], references: [editions.id] }), group: one(groups, { fields: [editionGroups.groupId], references: [groups.id] }) }));
export const storiesRelations = relations(stories, ({ one, many }) => ({
  edition: one(editions, { fields: [stories.editionId], references: [editions.id] }),
  group: one(groups, { fields: [stories.groupId], references: [groups.id] }),
  thread: one(threads, { fields: [stories.threadId], references: [threads.id] }),
  sources: many(storySources), posts: many(storyPosts), corrections: many(corrections),
}));
export const storySourcesRelations = relations(storySources, ({ one }) => ({ story: one(stories, { fields: [storySources.storyId], references: [stories.id] }), item: one(items, { fields: [storySources.itemId], references: [items.id] }) }));
export const storyPostsRelations = relations(storyPosts, ({ one }) => ({ story: one(stories, { fields: [storyPosts.storyId], references: [stories.id] }), post: one(posts, { fields: [storyPosts.postId], references: [posts.id] }) }));
export const threadsRelations = relations(threads, ({ many }) => ({ stories: many(stories) }));
export const runsRelations = relations(runs, ({ many }) => ({ sources: many(runSources) }));
export const runSourcesRelations = relations(runSources, ({ one }) => ({ run: one(runs, { fields: [runSources.runId], references: [runs.id] }), source: one(sources, { fields: [runSources.sourceId], references: [sources.id] }) }));
export const correctionsRelations = relations(corrections, ({ one }) => ({ story: one(stories, { fields: [corrections.storyId], references: [stories.id] }) }));
export const topicsRelations = relations(topics, ({ one }) => ({ group: one(groups, { fields: [topics.groupId], references: [groups.id] }) }));
