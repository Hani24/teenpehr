/**
 * zod contracts for /api/worker/* (mirrors docs/API.md). The worker's pydantic models must match.
 */
import { z } from "zod";
import { EVENT_TYPES, TOPICS } from "./taxonomy";
import { IMAGE_MAX_SOURCE_PX, IMAGE_MAX_VARIANTS, IMAGE_MAX_VARIANT_BYTES, IMAGE_MAX_VARIANT_H, IMAGE_MAX_VARIANT_W, IMAGE_MIN_VARIANT_W } from "./media";

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const slot = z.enum(["subh", "dopahar", "shaam"]);
export const isoDateTime = z.string().datetime({ offset: true });
/** Any parseable http(s) URL, including non-ASCII paths (zod's .url() rejects Arabic and Urdu paths). */
export const httpUrl = z.string().min(8).max(2000).refine((s) => isHttpUrl(s), "Invalid URL");
function isHttpUrl(s: string): boolean {
  if (s.length < 8 || s.length > 2000) return false;
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

/** Serialized size of a JSON value in bytes. */
export function jsonBytes(v: unknown): number {
  const s = JSON.stringify(v);
  return s === undefined ? 0 : new TextEncoder().encode(s).length;
}
export const ITEM_RAW_MAX_BYTES = 16_384;
export const RUN_OUTPUT_MAX_BYTES = 262_144;

/*
 * Metadata fields (items, posts, story research fields) never fail a request over length or a stray
 * bad entry: text is trimmed and cut, list entries that are not valid are dropped. Types and enums are
 * still strict. Absent item and post metadata stays undefined, so a route can leave stored values alone.
 */
const cut = (max: number) => z.string().transform((s) => s.trim().slice(0, max));
/** One plain line: control characters and line breaks become spaces, runs of whitespace one space. */
const oneLine = (s: string) => Array.from(s, (c) => (c.charCodeAt(0) < 32 || c === "\u007f" ? " " : c)).join("").replace(/\s+/g, " ").trim();
const optText = (max: number) => cut(max).nullable().optional();
const unique = (a: string[]) => [...new Set(a)];
/** Trimmed, cut, de-duplicated; `strip` removes a leading marker first (# of a hashtag, @ of a mention). */
const textList = (maxLen: number, maxItems: number, strip?: RegExp) =>
  z.array(z.string()).max(500).transform((a) => unique(a.map((s) => (strip ? s.trim().replace(strip, "") : s).trim().slice(0, maxLen)).filter(Boolean)).slice(0, maxItems));

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
  status: z.enum(["ok", "failed", "empty", "skipped"]),
  // null when no Claude call succeeded (X collector runs, empty or skipped edition runs)
  model: z.string().max(100).nullable().optional(),
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
  // Optional feed metadata (docs/API.md § POST /api/worker/items).
  author: optText(300),
  categories: textList(100, 30).optional(),
  image_url: z.string().nullable().optional().transform((s) => (s && isHttpUrl(s) ? s : s === undefined ? undefined : null)),
  description: optText(5000),
  word_count: z.number().int().nonnegative().nullable().optional(),
  lang_detected: optText(16),
  guid: optText(2000),
  feed_updated_at: isoDateTime.nullable().optional(),
  site_name: optText(200),
  fetch: z.object({
    route: z.enum(["direct", "germany"]).optional(),
    tier: z.number().int().min(0).max(3).optional(),
    status: z.number().int().min(0).max(999).optional(),
    ms: z.number().int().nonnegative().optional(),
    via: cut(40).optional(),
  }).optional(),
  // A subset of the feed entry; over ITEM_RAW_MAX_BYTES it is dropped (stored as null), never an error.
  raw: z.record(z.string(), z.unknown()).nullable().optional()
    .transform((v) => (v === undefined ? undefined : v && jsonBytes(v) <= ITEM_RAW_MAX_BYTES ? v : null)),
});
export const itemsIn = z.object({ run_id: z.number().int().positive().nullable().optional(), items: z.array(itemIn).max(5000) });

const mediaIn = z.object({
  type: z.enum(["photo", "video", "gif", "other"]),
  url: httpUrl,
  preview_url: httpUrl.optional(),
  alt: cut(1000).optional(),
});

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
  // Optional metadata (docs/API.md § POST /api/worker/posts).
  lang: optText(16),
  metrics: z.object({
    replies: z.number().int().nonnegative().optional(),
    reposts: z.number().int().nonnegative().optional(),
    likes: z.number().int().nonnegative().optional(),
    quotes: z.number().int().nonnegative().optional(),
    views: z.number().int().nonnegative().optional(),
    bookmarks: z.number().int().nonnegative().optional(),
  }).nullable().optional(),
  hashtags: textList(140, 50, /^#/).optional(),
  mentions: textList(100, 50, /^@/).optional(),
  urls: z.array(z.string()).max(200).transform((a) => unique(a.filter(isHttpUrl)).slice(0, 20)).optional(),
  media: z.array(z.unknown()).max(50).transform((a) => a.flatMap((m) => {
    const r = mediaIn.safeParse(m);
    return r.success ? [r.data] : [];
  }).slice(0, 10)).nullable().optional(),
  in_reply_to: optText(200),
  conversation_id: optText(200),
});
export const postsIn = z.object({ run_id: z.number().int().positive().nullable().optional(), posts: z.array(postIn).max(5000) });

export const entityIn = z.object({
  name_en: z.string().trim().min(1).max(200),
  name_ur: cut(200).optional(),
  kind: z.enum(["person", "org", "place", "event", "other"]),
  role: cut(40).optional(),
  salience: z.number().min(0).max(1).optional(),
});

export const angleIn = z.object({ item_id: z.number().int().positive(), note_en: z.string().max(300), note_ur: z.string().max(300).default("") });

export const storyIn = z.object({
  order: z.number().int().nonnegative(),
  thread: z.string().max(120).nullable().optional(),
  // Written by a model that read untrusted items, and shown back to the curate pass for two weeks
  // (/api/worker/config): stored as one plain line.
  thread_title_en: z.string().max(200).transform(oneLine).nullable().optional(),
  thread_title_ur: z.string().max(200).transform(oneLine).nullable().optional(),
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
  // Research metadata (docs/API.md § PUT …/editions): all optional; topics and event_type from lib/taxonomy.ts.
  keywords: textList(60, 20).default([]),
  topics: z.array(z.enum(TOPICS)).max(TOPICS.length).default([]).transform(unique),
  countries: z.array(z.string().regex(/^[A-Za-z]{2}$/, "ISO 3166-1 alpha-2")).max(50).default([]).transform((a) => unique(a.map((c) => c.toUpperCase()))),
  places: textList(100, 20).default([]),
  event_type: z.enum(EVENT_TYPES).nullable().optional(),
  entities: z.array(entityIn).max(40).default([]),
  // An image from POST /api/worker/images whose item or post this story cites (sources or posts); else a 400.
  image_id: z.number().int().positive().nullable().optional(),
});

export const editionGroupIn = z.object({
  group: z.string().min(1).max(60),
  lead_en: z.string().max(400).default(""),
  lead_ur: z.string().max(400).default(""),
  item_count: z.number().int().nonnegative().default(0),
  stories: z.array(storyIn).max(30),
});

export const editionIn = z.object({
  run_id: z.number().int().positive().nullable().optional(),
  status: z.enum(["draft", "review"]).default("draft"),
  // true: replace only the groups in this payload and keep the draft's other groups (worker --groups runs)
  partial: z.boolean().default(false),
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

/** POST /api/worker/runs/{id}/outputs: each Claude call's structured output, kept for audit and prompt work. */
export const runOutputIn = z.object({
  group: z.string().min(1).max(60).nullable().optional(), // group slug; absent for a call that covers every group
  stage: z.enum(["curate", "urdu", "qa", "image"]), // "image": a story image's vision-check verdict (D6)
  model: z.string().max(100).default(""),
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().default(0),
  output: z.unknown().refine((v) => v !== undefined && v !== null && jsonBytes(v) <= RUN_OUTPUT_MAX_BYTES, "output: required, JSON of at most 256 KB"),
});
export const runOutputsIn = z.object({ outputs: z.array(runOutputIn).min(1).max(100) });

export const handleSeenIn = z.object({ last_post_at: isoDateTime.optional(), fallback_used: z.boolean().default(false) });

/*
 * POST /api/worker/images: one publisher image, already downloaded, stripped and re-encoded by the worker.
 * Limits from lib/media.ts; the route also checks each variant's bytes (a still WebP of exactly w×h).
 * Base64 is checked strictly here, so the route's Buffer.from never skips junk.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const imageVariantIn = z.object({
  w: z.number().int().min(IMAGE_MIN_VARIANT_W).max(IMAGE_MAX_VARIANT_W),
  h: z.number().int().min(1).max(IMAGE_MAX_VARIANT_H),
  mime: z.literal("image/webp"),
  data_base64: z.string().min(16).max(Math.ceil(IMAGE_MAX_VARIANT_BYTES / 3) * 4)
    .refine((s) => BASE64.test(s), "not canonical base64")
    .refine((s) => (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0) <= IMAGE_MAX_VARIANT_BYTES, `over ${IMAGE_MAX_VARIANT_BYTES} bytes decoded`),
});
export const imageIn = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "64 lower-case hex digits"),
  source_url: httpUrl,
  // Exactly one: the cited item (article) or the cited post the image belongs to.
  item_id: z.number().int().positive().nullable().optional(),
  post_id: z.number().int().positive().nullable().optional(),
  // The feed the item came through (defaults to items.source_id); never with post_id.
  source_id: z.number().int().positive().nullable().optional(),
  credit: z.string().transform((s) => oneLine(s).slice(0, 120)).pipe(z.string().min(1, "empty credit")),
  // The publisher's own text (og:image:alt, media description), never a model's; empty is none.
  alt: z.string().transform((s) => oneLine(s).slice(0, 500) || null).nullable().optional(),
  graphic: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "#rrggbb").transform((s) => s.toLowerCase()),
  width: z.number().int().min(1).max(IMAGE_MAX_SOURCE_PX),
  height: z.number().int().min(1).max(IMAGE_MAX_SOURCE_PX),
  variants: z.array(imageVariantIn).min(1).max(IMAGE_MAX_VARIANTS),
}).superRefine((v, ctx) => {
  if ((v.item_id == null) === (v.post_id == null)) ctx.addIssue({ code: "custom", path: ["item_id"], message: "exactly one of item_id and post_id" });
  if (v.post_id != null && v.source_id != null) ctx.addIssue({ code: "custom", path: ["source_id"], message: "source_id goes with item_id, not post_id" });
  const ws = v.variants.map((x) => x.w);
  if (new Set(ws).size !== ws.length) ctx.addIssue({ code: "custom", path: ["variants"], message: "variant widths must differ" });
  v.variants.forEach((x, i) => {
    if (x.w > v.width) ctx.addIssue({ code: "custom", path: ["variants", i, "w"], message: "wider than the image (never upscale)" });
    // Same shape as the image, give or take rounding.
    if (Math.abs(x.h - (x.w * v.height) / v.width) > 2) ctx.addIssue({ code: "custom", path: ["variants", i, "h"], message: "not the image's aspect ratio" });
  });
});

export type RunStart = z.infer<typeof runStart>;
export type RunFinish = z.infer<typeof runFinish>;
export type ItemsIn = z.infer<typeof itemsIn>;
export type PostsIn = z.infer<typeof postsIn>;
export type EditionIn = z.infer<typeof editionIn>;
export type StoryIn = z.infer<typeof storyIn>;
export type ItemIn = z.infer<typeof itemIn>;
export type PostIn = z.infer<typeof postIn>;
export type EntityIn = z.infer<typeof entityIn>;
export type RunOutputsIn = z.infer<typeof runOutputsIn>;
export type ImageIn = z.infer<typeof imageIn>;
