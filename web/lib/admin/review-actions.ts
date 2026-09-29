"use server";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { EDITIONS_TAG } from "@/lib/cache-tags";
import { syncEntityStats } from "@/lib/insights";
import { WITHDRAW_NOTE_MAX } from "@/lib/codes";
import { normalizeUrdu } from "@/lib/urdu";
import { requireAdmin, requireOwner } from "./session";
import { all, bool, str, withFlash } from "./util";
import { markEditionReviewed, markReviewed, restoreStory, undoReview, withdrawStory, type ReviewResult } from "./review";

/*
 * Server actions of the Review page (decision D14, lib/admin/review.ts). Server Actions are public endpoints,
 * so each checks the role itself (editors review and withdraw; owners undo either), validates its input with
 * zod, and the change and its audit_log row happen in lib/admin/review.ts. Every action then expires the
 * cached reader pages (the pills, the story page, the edition's "N of M reviewed", feeds, search and the X
 * board all read the review state) and the admin pages that count it.
 */

const id = z.coerce.number().int().positive().max(2_147_483_647);
const storyForm = z.object({ story_id: id });
const editionForm = z.object({ edition_id: id, story_ids: z.array(id).min(1).max(500) });
const withdrawForm = z.object({
  story_id: id,
  note_en: z.string().max(WITHDRAW_NOTE_MAX),
  note_ur: z.string().max(WITHDRAW_NOTE_MAX),
  confirm: z.literal(true, { error: "tick the box to confirm the withdrawal" }),
}).refine((d) => d.note_en.trim() !== "" || d.note_ur.trim() !== "", { path: ["note_en"], message: "give the reason in English or Urdu (or both)" });

/** A same-site admin page to return to (the review page with its tab, or an edition); anything else falls back. */
function backTo(fd: FormData, fallback: string): string {
  const b = str(fd, "back");
  return /^\/admin(?:\/[A-Za-z0-9/_\-.#?=&%]*)?$/.test(b) && !b.includes("//") ? b : fallback;
}

/** Readers see the change at once; the admin pages that count or list it are refreshed. */
function refresh(): void {
  revalidatePath("/", "layout");
  updateTag(EDITIONS_TAG);
  revalidatePath("/admin", "layout");
}

async function finish(back: string, r: ReviewResult, anchor = ""): Promise<never> {
  if (r.ok) refresh();
  redirect(await withFlash(`${back}${anchor}`, r.ok ? { ok: r.message } : { error: r.error }));
}

function issues(e: z.ZodError): string {
  return e.issues.slice(0, 3).map((i) => `${String(i.path[0] ?? "form")}: ${i.message}`).join("; ");
}

export async function markReviewedAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/review");
  const back = backTo(fd, "/admin/review");
  const p = storyForm.safeParse({ story_id: str(fd, "story_id") });
  if (!p.success) redirect(await withFlash(back, { error: issues(p.error) }));
  await finish(back, await markReviewed(user, p.data.story_id));
}

export async function markEditionReviewedAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/review");
  const back = backTo(fd, "/admin/review");
  const p = editionForm.safeParse({ edition_id: str(fd, "edition_id"), story_ids: all(fd, "story_ids") });
  if (!p.success) redirect(await withFlash(back, { error: issues(p.error) }));
  await finish(back, await markEditionReviewed(user, p.data.edition_id, p.data.story_ids));
}

export async function undoReviewAction(fd: FormData): Promise<void> {
  const user = await requireOwner("/admin/review");
  const back = backTo(fd, "/admin/review?show=reviewed");
  const p = storyForm.safeParse({ story_id: str(fd, "story_id") });
  if (!p.success) redirect(await withFlash(back, { error: issues(p.error) }));
  await finish(back, await undoReview(user, p.data.story_id));
}

export async function withdrawStoryAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/review");
  const back = backTo(fd, "/admin/review");
  const p = withdrawForm.safeParse({
    story_id: str(fd, "story_id"), note_en: str(fd, "note_en"), note_ur: normalizeUrdu(str(fd, "note_ur")), confirm: bool(fd, "confirm"),
  });
  if (!p.success) redirect(await withFlash(back, { error: `Not withdrawn: ${issues(p.error)}.` }));
  const r = await withdrawStory(user, p.data.story_id, { en: p.data.note_en, ur: p.data.note_ur });
  // A withdrawn story no longer counts toward its entities' mention counts (entity pages, Insights).
  if (r.ok) await syncEntityStats().catch((e) => console.error("entity stats:", (e as Error).message));
  await finish(back, r);
}

export async function restoreStoryAction(fd: FormData): Promise<void> {
  const user = await requireOwner("/admin/review");
  const back = backTo(fd, "/admin/review?show=withdrawn");
  const p = storyForm.safeParse({ story_id: str(fd, "story_id") });
  if (!p.success) redirect(await withFlash(back, { error: issues(p.error) }));
  const r = await restoreStory(user, p.data.story_id);
  if (r.ok) await syncEntityStats().catch((e) => console.error("entity stats:", (e as Error).message));
  await finish(back, r);
}
