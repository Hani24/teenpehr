"use server";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { FEEDBACK_REASONS, REPORT_TEXT_MAX, type FeedbackReason } from "@/lib/codes";
import { storyVisibleSql } from "@/lib/desk";
import { normalizeUrdu } from "@/lib/urdu";

/*
 * Relevance feedback and "Report a mistake" (decision D8), written by the signed-in reader for themselves:
 * no action takes a user id, so a reader can only ever set, change or remove their own answer. Only a story
 * readers can see (in a published edition, or live on the Editor's desk) takes answers. A signed-out caller
 * is sent to sign in (requireUser), then back to `next`.
 *
 * The answers are for insights, the owner-only interest profiles and a later "For you" ordering that may
 * reweight topics and sections only: nothing here hides a story from the shared edition or drops an outlet.
 */

const { storyFeedback, storyReports, stories, editions } = schema;

/** Most mistake reports one reader may send in a day; the same text again is refused for a day. */
const REPORTS_PER_DAY = 10;
/** Namespace of the per-reader advisory lock around a report's checks and insert (translations use 0x7442_0009). */
const REPORT_LOCK_NS = 0x7442_0008;

const idSchema = z.number().int().positive().max(2_147_483_647);
const common = {
  locale: z.enum(["en", "ur"]).optional(),
  // Where to come back to after signing in; loginPath() keeps only same-site paths. Too long is dropped.
  next: z.string().max(512).optional().catch(undefined),
};
const voteSchema = z.object({
  /** 1 "Relevant to me", -1 "Show less like this", 0 removes the answer. */
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  /** Only with -1; at most one of each. */
  reasons: z.array(z.enum(FEEDBACK_REASONS)).max(FEEDBACK_REASONS.length).optional(),
  ...common,
}).strict();

/**
 * The report text as stored: NFC, control characters other than line breaks and tabs removed, runs of
 * blank lines collapsed, trimmed, and Urdu code points (ی ک ہ) when it is written in Arabic script.
 */
function cleanText(raw: string): string {
  const s = raw.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b\u2028\u2029]/g, " ")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return /[؀-ۿ]/.test(s) ? normalizeUrdu(s) : s;
}
const reportSchema = z.object({ text: z.string().max(REPORT_TEXT_MAX * 4), ...common }).strict();

export type VoteResult = { ok: true; value: 1 | -1 | 0; reasons: FeedbackReason[] } | { ok: false; error: "invalid" | "not_found" };
export type ReportResult = { ok: true; id: number } | { ok: false; error: "invalid" | "empty" | "too_long" | "not_found" | "limit" | "duplicate" };

async function visible(storyId: number): Promise<boolean> {
  const [s] = await db.select({ id: stories.id }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId))
    .where(and(eq(stories.id, storyId), storyVisibleSql)).limit(1);
  return !!s;
}

/**
 * Set, change or remove the signed-in reader's answer on a story. Idempotent: the client says which answer
 * it wants, so a double tap or a retry never flips twice. Reasons are kept only with "Show less like this".
 */
export async function setStoryFeedback(storyId: number, input: unknown): Promise<VoteResult> {
  const id = idSchema.safeParse(storyId);
  const v = voteSchema.safeParse(input);
  if (!id.success || !v.success) return { ok: false, error: "invalid" };
  const user = await requireUser({ locale: v.data.locale, next: v.data.next });
  const mine = and(eq(storyFeedback.userId, user.id), eq(storyFeedback.storyId, id.data));
  if (v.data.value === 0) {
    await db.delete(storyFeedback).where(mine);
    return { ok: true, value: 0, reasons: [] };
  }
  if (!(await visible(id.data))) return { ok: false, error: "not_found" };
  const reasons = v.data.value === -1 ? FEEDBACK_REASONS.filter((r) => v.data.reasons?.includes(r)) : [];
  await db.insert(storyFeedback).values({ userId: user.id, storyId: id.data, value: v.data.value, reasons })
    .onConflictDoUpdate({ target: [storyFeedback.userId, storyFeedback.storyId], set: { value: v.data.value, reasons, updatedAt: sql`now()` } });
  return { ok: true, value: v.data.value, reasons };
}

/**
 * "Report a mistake": the reader's free text to the editors' queue (/admin/reports). Not a vote. At most
 * REPORTS_PER_DAY a day per reader, and the same text on the same story is taken once a day.
 */
export async function reportMistake(storyId: number, input: unknown): Promise<ReportResult> {
  const id = idSchema.safeParse(storyId);
  const r = reportSchema.safeParse(input);
  if (!id.success || !r.success) return { ok: false, error: r.success ? "invalid" : r.error.issues.some((i) => i.code === "too_big") ? "too_long" : "invalid" };
  const user = await requireUser({ locale: r.data.locale, next: r.data.next });
  const text = cleanText(r.data.text);
  if (!text) return { ok: false, error: "empty" };
  // The database checks char_length (code points), so count code points here too.
  if ([...text].length > REPORT_TEXT_MAX) return { ok: false, error: "too_long" };
  if (!(await visible(id.data))) return { ok: false, error: "not_found" };
  const dayAgo = sql`now() - interval '1 day'`;
  return db.transaction(async (tx): Promise<ReportResult> => {
    // One report at a time per reader (released at commit), so a burst of parallel sends cannot all pass the
    // day's limit or the duplicate check before any of them is written.
    await tx.execute(sql`select pg_advisory_xact_lock(${REPORT_LOCK_NS}, ${user.id})`);
    const [{ n }] = await tx.select({ n: count() }).from(storyReports).where(and(eq(storyReports.userId, user.id), gt(storyReports.createdAt, dayAgo)));
    if (n >= REPORTS_PER_DAY) return { ok: false, error: "limit" };
    const [same] = await tx.select({ id: storyReports.id }).from(storyReports)
      .where(and(eq(storyReports.userId, user.id), eq(storyReports.storyId, id.data), eq(storyReports.text, text), gt(storyReports.createdAt, dayAgo))).limit(1);
    if (same) return { ok: false, error: "duplicate" };
    const [row] = await tx.insert(storyReports).values({ userId: user.id, storyId: id.data, text, locale: r.data.locale ?? "en" }).returning({ id: storyReports.id });
    return { ok: true, id: row.id };
  });
}
