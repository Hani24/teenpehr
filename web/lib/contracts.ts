/**
 * zod contracts for /api/worker/* (mirrors docs/API.md). The worker's pydantic models must match.
 */
import { z } from "zod";

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const slot = z.enum(["subh", "dopahar", "shaam"]);
export const isoDateTime = z.string().datetime({ offset: true });
/** Any parseable http(s) URL, including non-ASCII paths (zod's .url() rejects Arabic and Urdu paths). */
export const httpUrl = z.string().min(8).max(2000).refine((s) => {
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}, "Invalid URL");

export const runStart = z.object({
  kind: z.enum(["edition", "x_collect"]),
  date: isoDate.optional(),
  slot: slot.optional(),
});

export const runSourceResult = z.object({
  source_id: z.number().int().positive(),
  ok: z.boolean(),
  items: z.number().int().nonnegative().default(0),
  error: z.string().transform((s) => s.slice(0, 500)).nullable().optional(),
  ms: z.number().int().nonnegative().default(0),
  tier: z.number().int().min(0).max(3).default(0),
  route: z.enum(["direct", "germany"]).default("direct"),
});

export const runFinish = z.object({
  status: z.enum(["ok", "failed", "empty"]),
  model: z.string().max(100).optional(),
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().default(0),
  log: z.string().max(200_000).default(""),
  error: z.string().max(8000).nullable().optional(),
  sources: z.array(runSourceResult).default([]),
});

export const itemIn = z.object({
  source_id: z.number().int().positive(),
  url: httpUrl,
  url_canonical: z.string().min(3).max(2000),
  title: z.string().min(1).max(500),
  text: z.string().max(20_000).default(""),
  published_at: isoDateTime.nullable().optional(),
  lang: z.string().min(2).max(8).default("en"),
  content_hash: z.string().min(8).max(128),
});
export const itemsIn = z.object({ run_id: z.number().int().positive().optional(), items: z.array(itemIn).max(5000) });

export const postIn = z.object({
  platform: z.enum(["x", "bluesky", "telegram", "youtube"]).default("x"),
  platform_id: z.string().min(1).max(200),
  author_handle: z.string().min(1).max(100),
  author_name: z.string().max(200).default(""),
  text: z.string().max(10_000),
  url: httpUrl,
  posted_at: isoDateTime,
  is_repost: z.boolean().default(false),
  raw: z.unknown().optional(),
});
export const postsIn = z.object({ run_id: z.number().int().positive().optional(), posts: z.array(postIn).max(5000) });

export const angleIn = z.object({ item_id: z.number().int().positive(), note_en: z.string().max(300), note_ur: z.string().max(300).default("") });

export const storyIn = z.object({
  order: z.number().int().nonnegative(),
  thread: z.string().max(120).nullable().optional(),
  thread_title_en: z.string().max(200).nullable().optional(),
  thread_title_ur: z.string().max(200).nullable().optional(),
  title_en: z.string().min(1).max(300),
  title_ur: z.string().max(300).default(""),
  summary_en: z.string().min(1).max(3000),
  summary_ur: z.string().max(3000).default(""),
  why_en: z.string().max(1000).default(""),
  why_ur: z.string().max(1000).default(""),
  tag: z.enum(["must-read", "worth-knowing", "skim"]).default("worth-knowing"),
  coverage: z.enum(["broad", "partisan", "single-source"]).nullable().optional(),
  contested_en: z.string().max(1000).default(""),
  contested_ur: z.string().max(1000).default(""),
  angles: z.array(angleIn).max(12).default([]),
  sources: z.array(z.object({ item_id: z.number().int().positive(), is_primary: z.boolean().default(false) })).min(1).max(40),
  posts: z.array(z.number().int().positive()).max(20).default([]),
  qa_status: z.enum(["pending", "verified", "flagged"]).default("pending"),
  qa_note: z.string().max(1000).default(""),
});

export const editionGroupIn = z.object({
  group: z.string().min(1).max(60),
  lead_en: z.string().max(400).default(""),
  lead_ur: z.string().max(400).default(""),
  item_count: z.number().int().nonnegative().default(0),
  stories: z.array(storyIn).max(30),
});

export const editionIn = z.object({
  run_id: z.number().int().positive().optional(),
  status: z.enum(["draft", "review"]).default("draft"),
  groups: z.array(editionGroupIn).min(1).max(20),
});

export const publishIn = z.object({ force: z.boolean().default(false), notify: z.boolean().default(true) });

export const glossaryIn = z.object({
  entries: z.array(z.object({
    term_en: z.string().min(1).max(200),
    term_ur: z.string().min(1).max(200),
    kind: z.enum(["person", "place", "org", "other"]).default("other"),
  })).max(500),
});

export const handleSeenIn = z.object({ last_post_at: isoDateTime.optional(), fallback_used: z.boolean().default(false) });

export type RunStart = z.infer<typeof runStart>;
export type RunFinish = z.infer<typeof runFinish>;
export type ItemsIn = z.infer<typeof itemsIn>;
export type PostsIn = z.infer<typeof postsIn>;
export type EditionIn = z.infer<typeof editionIn>;
export type StoryIn = z.infer<typeof storyIn>;
