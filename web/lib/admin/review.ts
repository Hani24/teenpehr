import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { roleAtLeast, type SessionUser } from "@/lib/auth";
import { writeAudit } from "./manual";

/*
 * The editors' Review page (decision D14 in docs/PLAN.md): every edition publishes without waiting for an
 * editor, each AI-written story shows readers whether one has reviewed it, and editors review whenever.
 *
 * - The queue: AI-written stories of published editions that no editor has reviewed and nobody withdrew,
 *   grouped by edition (newest first), QA-flagged stories first within each edition.
 * - Mark reviewed (one story, or every story shown for an edition): stories.reviewed_at/by. Undo: owners.
 * - Withdraw (editors, a reason in English and/or Urdu, after a confirm step): stories.withdrawn_at/by and
 *   the note; the story leaves every reader list and its address says only that it was withdrawn, when and
 *   why. Undo (restore): owners.
 *
 * Review state is metadata: none of this touches a story's text, which stays as published (corrections are
 * appended rows, lib/admin/actions.ts addCorrection). Every change is written to audit_log (target
 * "story:<id>") by the function that makes it, inside its transaction; lib/admin/review-actions.ts checks
 * roles, validates input and expires the cached reader pages.
 */

const { stories, editions, users } = schema;

/** The queue's rule, for plain selects joined to editions. */
const inQueue = and(eq(editions.status, "published"), eq(stories.origin, "ai"), isNull(stories.reviewedAt), isNull(stories.withdrawnAt));

/** How many stories wait for review, and how many of them QA flagged (the admin nav and dashboard). */
export async function reviewQueueCounts(): Promise<{ unreviewed: number; flagged: number }> {
  const [r] = await db.select({
    unreviewed: sql<number>`count(*)`.mapWith(Number),
    flagged: sql<number>`count(*) filter (where ${stories.qaStatus} = 'flagged')`.mapWith(Number),
  }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId)).where(inQueue);
  return { unreviewed: r?.unreviewed ?? 0, flagged: r?.flagged ?? 0 };
}

export type ReviewTab = "todo" | "reviewed" | "withdrawn";
export const REVIEW_TABS: readonly ReviewTab[] = ["todo", "reviewed", "withdrawn"];
/** Most stories one page lists. */
export const REVIEW_PAGE_MAX = 150;

const itemCols = { search: false, raw: false } as const;
const imageCols = { sourceUrl: false, createdAt: false } as const;
const person = { columns: { id: true, name: true, email: true } } as const;

/**
 * The stories one tab shows, with everything a reviewer needs (both languages, sources, posts, image, QA
 * note, corrections), newest edition first. `todo`: the queue, flagged first within an edition. `reviewed`:
 * most recently reviewed first. `withdrawn`: most recently withdrawn first. `editionId` narrows to one edition.
 */
export async function reviewStories(tab: ReviewTab, editionId?: number) {
  const where = tab === "todo" ? inQueue
    : tab === "reviewed" ? and(eq(editions.status, "published"), isNotNull(stories.reviewedAt), isNull(stories.withdrawnAt))
    : isNotNull(stories.withdrawnAt);
  const order = tab === "todo"
    ? [desc(editions.date), desc(editions.slot), sql`(${stories.qaStatus} = 'flagged') desc`, stories.groupId, stories.order, stories.id]
    : tab === "reviewed" ? [desc(stories.reviewedAt), desc(stories.id)] : [desc(stories.withdrawnAt), desc(stories.id)];
  const ids = await db.select({ id: stories.id }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId))
    .where(editionId ? and(where, eq(stories.editionId, editionId)) : where).orderBy(...order).limit(REVIEW_PAGE_MAX + 1);
  const more = ids.length > REVIEW_PAGE_MAX;
  const list = ids.slice(0, REVIEW_PAGE_MAX).map((r) => r.id);
  if (!list.length) return { stories: [], more: false };
  const rows = await db.query.stories.findMany({
    where: inArray(stories.id, list),
    columns: { searchEn: false, searchUr: false },
    with: {
      edition: true, group: true, thread: true,
      sources: { with: { item: { columns: itemCols, with: { source: true } } } },
      posts: { with: { post: { columns: { raw: false } } } },
      corrections: { orderBy: (c, { asc }) => [asc(c.createdAt), asc(c.id)] },
      image: { columns: imageCols },
      reviewer: person, withdrawer: person,
    },
  });
  const at = new Map(list.map((id, i) => [id, i]));
  return { stories: rows.sort((a, b) => at.get(a.id)! - at.get(b.id)!), more };
}
export type ReviewStory = Awaited<ReturnType<typeof reviewStories>>["stories"][number];

// ---- changes -------------------------------------------------------------------------------------

export type ReviewResult = { ok: true; message: string } | { ok: false; error: string };

type StoryRow = { id: number; editionId: number; origin: string; reviewedAt: Date | null; withdrawnAt: Date | null; status: string; deskAt: Date | null; titleEn: string };

/** The story row, locked, with its edition's status. */
async function lockStory(tx: Tx, id: number): Promise<StoryRow | null> {
  const [s] = await tx.select({
    id: stories.id, editionId: stories.editionId, origin: stories.origin, reviewedAt: stories.reviewedAt, withdrawnAt: stories.withdrawnAt,
    status: editions.status, deskAt: stories.deskAt, titleEn: stories.titleEn,
  }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId)).where(eq(stories.id, id)).for("update", { of: stories });
  return s ?? null;
}

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

/** Mark one story reviewed: an AI-written story of a published edition, not withdrawn, not reviewed yet. */
export async function markReviewed(user: SessionUser, id: number): Promise<ReviewResult> {
  return db.transaction(async (tx) => {
    const s = await lockStory(tx, id);
    if (!s) return { ok: false as const, error: `Story ${id} does not exist.` };
    if (s.status !== "published") return { ok: false as const, error: `Story ${id} is not in a published edition; review applies to published stories.` };
    if (s.origin !== "ai") return { ok: false as const, error: `Story ${id} is a manual entry: an editor wrote it, and it carries no review state.` };
    if (s.withdrawnAt) return { ok: false as const, error: `Story ${id} was withdrawn.` };
    if (s.reviewedAt) return { ok: true as const, message: `Story ${id} was already reviewed.` };
    const now = new Date();
    await tx.update(stories).set({ reviewedAt: now, reviewedBy: user.id }).where(and(eq(stories.id, id), isNull(stories.reviewedAt)));
    await writeAudit(tx, user.id, "story.review", `story:${id}`, { edition_id: s.editionId, title: short(s.titleEn) });
    return { ok: true as const, message: `Story ${id} marked reviewed.` };
  });
}

/**
 * Mark the given stories of one edition reviewed ("all shown in this edition"): only those still in the
 * queue, so a story someone withdrew or reviewed meanwhile is left as it is. One audit row per story.
 */
export async function markEditionReviewed(user: SessionUser, editionId: number, ids: number[]): Promise<ReviewResult> {
  if (!ids.length) return { ok: false, error: "No stories were listed." };
  return db.transaction(async (tx) => {
    const [ed] = await tx.select({ status: editions.status, date: editions.date, slot: editions.slot }).from(editions).where(eq(editions.id, editionId)).for("update");
    if (!ed) return { ok: false as const, error: "Edition not found." };
    if (ed.status !== "published") return { ok: false as const, error: "That edition is not published." };
    const now = new Date();
    const done = await tx.update(stories).set({ reviewedAt: now, reviewedBy: user.id })
      .where(and(inArray(stories.id, ids), eq(stories.editionId, editionId), eq(stories.origin, "ai"), isNull(stories.reviewedAt), isNull(stories.withdrawnAt)))
      .returning({ id: stories.id, titleEn: stories.titleEn });
    for (const d of done) await writeAudit(tx, user.id, "story.review", `story:${d.id}`, { edition_id: editionId, title: short(d.titleEn), batch: true });
    const skipped = ids.length - done.length;
    return { ok: true as const, message: `${done.length} ${done.length === 1 ? "story" : "stories"} of ${ed.date} ${ed.slot} marked reviewed${skipped ? ` (${skipped} already reviewed, withdrawn or not in this edition)` : ""}.` };
  });
}

/** Undo a review (owners): the story shows readers "not reviewed" again. */
export async function undoReview(user: SessionUser, id: number): Promise<ReviewResult> {
  if (!roleAtLeast(user.role, "owner")) return { ok: false, error: "Only an owner can undo a review." };
  return db.transaction(async (tx) => {
    const s = await lockStory(tx, id);
    if (!s) return { ok: false as const, error: `Story ${id} does not exist.` };
    if (!s.reviewedAt) return { ok: true as const, message: `Story ${id} was not marked reviewed.` };
    const [was] = await tx.select({ by: stories.reviewedBy }).from(stories).where(eq(stories.id, id));
    await tx.update(stories).set({ reviewedAt: null, reviewedBy: null }).where(eq(stories.id, id));
    await writeAudit(tx, user.id, "story.review_undo", `story:${id}`, { reviewed_at: s.reviewedAt.toISOString(), reviewed_by: was?.by ?? null, title: short(s.titleEn) });
    return { ok: true as const, message: `Story ${id}: review undone; readers see it as not reviewed again.` };
  });
}

/**
 * Withdraw a story readers can see (a published edition's, or one live on the Editor's desk), with the
 * editors' reason in English and/or Urdu (at least one; normalised by the caller). Its text stays as published.
 */
export async function withdrawStory(user: SessionUser, id: number, note: { en: string; ur: string }): Promise<ReviewResult> {
  if (!note.en.trim() && !note.ur.trim()) return { ok: false, error: "Give the reason in English or Urdu (or both)." };
  return db.transaction(async (tx) => {
    const s = await lockStory(tx, id);
    if (!s) return { ok: false as const, error: `Story ${id} does not exist.` };
    if (s.status !== "published" && !s.deskAt) return { ok: false as const, error: `Story ${id} is not live: edit or remove the draft instead.` };
    if (s.withdrawnAt) return { ok: true as const, message: `Story ${id} was already withdrawn.` };
    // The row lock above holds off a publish moving a desk story (lib/desk.ts) until this commits.
    await tx.update(stories).set({ withdrawnAt: new Date(), withdrawnBy: user.id, withdrawNoteEn: note.en.trim(), withdrawNoteUr: note.ur.trim() })
      .where(and(eq(stories.id, id), isNull(stories.withdrawnAt)));
    await writeAudit(tx, user.id, "story.withdraw", `story:${id}`, { edition_id: s.editionId, title: short(s.titleEn), note_en: note.en.trim(), note_ur: note.ur.trim() });
    return { ok: true as const, message: `Story ${id} withdrawn. Readers now see only that it was withdrawn, with your note.` };
  });
}

/** Undo a withdrawal (owners): the story is back in its edition, the feeds and search. */
export async function restoreStory(user: SessionUser, id: number): Promise<ReviewResult> {
  if (!roleAtLeast(user.role, "owner")) return { ok: false, error: "Only an owner can restore a withdrawn story." };
  return db.transaction(async (tx) => {
    const s = await lockStory(tx, id);
    if (!s) return { ok: false as const, error: `Story ${id} does not exist.` };
    if (!s.withdrawnAt) return { ok: true as const, message: `Story ${id} is not withdrawn.` };
    const [was] = await tx.select({ by: stories.withdrawnBy, en: stories.withdrawNoteEn, ur: stories.withdrawNoteUr }).from(stories).where(eq(stories.id, id));
    await tx.update(stories).set({ withdrawnAt: null, withdrawnBy: null, withdrawNoteEn: "", withdrawNoteUr: "" }).where(eq(stories.id, id));
    await writeAudit(tx, user.id, "story.withdraw_undo", `story:${id}`, {
      withdrawn_at: s.withdrawnAt.toISOString(), withdrawn_by: was?.by ?? null, note_en: was?.en ?? "", note_ur: was?.ur ?? "", title: short(s.titleEn),
    });
    return { ok: true as const, message: `Story ${id} restored: readers see it again.` };
  });
}

/** Names for the audit rows the page shows (users.name, else the email: admin only). */
export async function userNames(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((u) => [u.id, u.name || u.email]));
}
