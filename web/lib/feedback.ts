import "server-only";
import { cache } from "react";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { FEEDBACK_REASONS, type FeedbackReason, type ReportStatus } from "@/lib/codes";

/*
 * Relevance feedback and "Report a mistake" (decision D8), the reader's side: what the signed-in reader
 * has said about stories, for their own buttons. A reader only ever sees their own answers, never counts
 * or anyone else's. Writes are in feedback-actions.ts; the editors' views (Insights, the report queue,
 * the owner-only interest profiles) are in lib/admin/feedback-insights.ts.
 */

const { storyFeedback, storyReports } = schema;

/** A reader's answer on one story: 1 "Relevant to me", -1 "Show less like this" with optional reasons. */
export type MyVote = { value: 1 | -1; reasons: FeedbackReason[] };

/** A row's reasons as the known codes, in FEEDBACK_REASONS order (the check constraint allows no others). */
export const cleanReasons = (rs: readonly string[]): FeedbackReason[] => FEEDBACK_REASONS.filter((r) => rs.includes(r));

/**
 * Every answer of the signed-in reader, by story id; null when nobody is signed in. One query per request
 * however many cards ask (cache()), like the Saved shelf's getSavedSets(): an index scan on the primary key.
 */
export const getMyVotes = cache(async (): Promise<Map<number, MyVote> | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const rows = await db.select({ storyId: storyFeedback.storyId, value: storyFeedback.value, reasons: storyFeedback.reasons })
    .from(storyFeedback).where(eq(storyFeedback.userId, user.id));
  return new Map(rows.filter((r) => r.value === 1 || r.value === -1).map((r) => [r.storyId, { value: r.value as 1 | -1, reasons: r.value === -1 ? cleanReasons(r.reasons) : [] }]));
});

/**
 * The reader's answer on one story for its buttons: `undefined` when signed out (no buttons), null when
 * they have not answered.
 */
export async function storyVote(storyId: number): Promise<MyVote | null | undefined> {
  const votes = await getMyVotes();
  if (!votes) return undefined;
  return votes.get(storyId) ?? null;
}

/** The signed-in reader's own mistake reports on a story, newest first (the form shows how many and the latest one's status). */
export type MyReport = { id: number; at: string; status: ReportStatus };
export async function myReports(storyId: number): Promise<MyReport[] | undefined> {
  const user = await getCurrentUser();
  if (!user) return undefined;
  const rows = await db.select({ id: storyReports.id, at: storyReports.createdAt, status: storyReports.status }).from(storyReports)
    .where(and(eq(storyReports.userId, user.id), eq(storyReports.storyId, storyId))).orderBy(desc(storyReports.createdAt)).limit(100);
  return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), status: r.status }));
}
