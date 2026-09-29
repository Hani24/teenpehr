"use server";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { REPORT_STATUSES, REPORT_TEXT_MAX } from "@/lib/codes";
import { EDITIONS_TAG } from "@/lib/cache-tags";
import { httpUrl } from "@/lib/contracts";
import { enqueueJob, jobKeys } from "@/lib/jobs";
import { normalizeUrdu } from "@/lib/urdu";
import { requireAdmin, requireOwner } from "./session";
import { all, bool, num, str, withFlash } from "./util";
import {
  cancelJob, checkLink, createManualStory, goLiveNow, linkOwner, manualLink, manualStorySchema, removeManualStory, retryJob, RETRYABLE_BLOCKS, signForSession,
  storyTextSchema, trustedPreview, trustedUpload, updateManualStory, writeAudit, type LinkPreview,
} from "./manual";
import { decideReport } from "./feedback-insights";
import { decideProposal, type Decision } from "./x-proposals";

/*
 * Server actions for the editor tools of decisions D8–D12: manual stories (D12), the reports queue (D8),
 * translation and job retries (D9, docs/API.md § Jobs) and X List proposals (D10). Every action checks the
 * role itself (Server Actions are public endpoints), validates its input with zod, and the logic lives in
 * ./manual.ts, ./feedback-insights.ts and ./x-proposals.ts, which write audit_log.
 */

/** What readers see changed: the rendered pages and the cached edition data (a desk story went live). */
const readersSeeIt = () => { revalidatePath("/", "layout"); updateTag(EDITIONS_TAG); };
/** A same-site admin page to return to; anything else falls back to `fallback`. */
function backTo(fd: FormData, fallback: string): string {
  const b = str(fd, "back");
  return /^\/admin(?:\/[A-Za-z0-9/_\-.#?=&%]*)?$/.test(b) && !b.includes("//") ? b : fallback;
}
const idOf = (fd: FormData, key = "id") => { const v = num(fd, key); return v && Number.isInteger(v) && v > 0 && v <= 2_147_483_647 ? v : null; };

// ---- manual stories (D12) ------------------------------------------------------------------

export type LinkCheckState =
  | null
  | {
      ok: true; preview: LinkPreview; json: string; sig: string;
      item: { id: number; title: string; source: string; kind: string } | null;
      outlet: { name: string; perspective: string; kind: string } | null;
    }
  | { ok: false; link: string; message: string; overridable: boolean };

/** "Check link": fetch the article once and hand back a preview signed for this session (the create step reuses it). */
export async function checkManualLink(_prev: LinkCheckState, fd: FormData): Promise<LinkCheckState> {
  await requireAdmin("/admin/stories/new");
  const link = str(fd, "link");
  if (!httpUrl.safeParse(link).success) return { ok: false, link, overridable: false, message: "Enter a full http(s) link to the article (https://…)." };
  if (!manualLink.safeParse(link).success) return { ok: false, link, overridable: false, message: "That address is not on the public internet. Enter the article's public link." };
  const [check, owner] = await Promise.all([checkLink(link), linkOwner(link)]);
  if (!check.ok) return { ok: false, link, message: check.message, overridable: check.overridable };
  const json = JSON.stringify(check.preview);
  const sig = await signForSession("manual-link", json);
  if (!sig) return { ok: false, link, overridable: false, message: "Your session has ended; sign in again." };
  return { ok: true, preview: check.preview, json, sig, ...owner };
}

export type CreateState = null | { error: string; needsOverride?: boolean };

/** Create the story (manual.ts createManualStory), then open its page. Errors come back inline, the form kept. */
export async function createManualStoryAction(_prev: CreateState, fd: FormData): Promise<CreateState> {
  const user = await requireAdmin("/admin/stories/new");
  const parsed = manualStorySchema.safeParse({
    link: str(fd, "link"), group_id: str(fd, "group_id"), tag: str(fd, "tag"), coverage: str(fd, "coverage"), topics: all(fd, "topics"), position: str(fd, "position") || "top",
    title_en: str(fd, "title_en"), summary_en: str(fd, "summary_en"), why_en: str(fd, "why_en"), contested_en: str(fd, "contested_en"),
    title_ur: str(fd, "title_ur"), summary_ur: str(fd, "summary_ur"), why_ur: str(fd, "why_ur"), contested_ur: str(fd, "contested_ur"),
    placement: str(fd, "placement"), edition: str(fd, "edition") || "upcoming", image: str(fd, "image") || "none",
    image_credit: str(fd, "image_credit"), image_alt: str(fd, "image_alt"), image_graphic: bool(fd, "image_graphic"), image_rights: bool(fd, "image_rights"),
    unchecked_ok: bool(fd, "unchecked_ok"),
  });
  if (!parsed.success) {
    const names: Record<string, string> = { link: "Link", group_id: "Section", tag: "Tag", coverage: "Coverage", placement: "Where it goes", edition: "Edition", topics: "Topics" };
    return { error: parsed.error.issues.slice(0, 4).map((i) => `${names[String(i.path[0])] ?? String(i.path[0] ?? "form")}: ${i.message}`).join("; ") };
  }
  const d = parsed.data;
  // The check's preview when there is one for this link; otherwise the one fetch happens now.
  let preview = await trustedPreview(d.link, str(fd, "preview_json"), str(fd, "preview_sig"));
  if (!preview) {
    const check = await checkLink(d.link);
    if (check.ok) preview = check.preview;
    else if (!check.overridable) return { error: check.message };
    else if (!d.unchecked_ok) return { error: `${check.message} If you opened the article yourself and it is real, tick "Add it anyway".`, needsOverride: true };
  }
  const upload = d.image === "upload" ? await trustedUpload(str(fd, "image_json"), str(fd, "image_sig")) : null;
  const r = await createManualStory(user, d, preview, upload);
  if (!r.ok) return { error: r.error };
  revalidatePath("/admin/stories");
  revalidatePath(`/admin/editions/${r.edition.id}`);
  if (r.live) readersSeeIt();
  const where = d.placement === "desk"
    ? r.live ? "It is live on the Editor's desk now." : `It goes live on the Editor's desk as soon as ${r.jobs.length ? `the worker finishes (${r.jobs.join(", ")})` : "it is ready"}.`
    : `It goes out with ${r.edition.date} ${r.edition.slot}${r.jobs.length ? ` once the worker finishes (${r.jobs.join(", ")})` : ""}.`;
  redirect(await withFlash(`/admin/stories/${r.id}`, { ok: `Story ${r.id} added. ${where}` }));
}

const editSchema = storyTextSchema.extend({ reviewed_filled: z.boolean() });

export async function updateManualStoryAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/stories");
  const id = idOf(fd);
  if (!id) redirect(await withFlash("/admin/stories", { error: "Unknown story." }));
  const back = `/admin/stories/${id}`;
  const parsed = editSchema.safeParse({
    group_id: str(fd, "group_id"), tag: str(fd, "tag"), coverage: str(fd, "coverage"), topics: all(fd, "topics"), position: str(fd, "position") || "top",
    title_en: str(fd, "title_en"), summary_en: str(fd, "summary_en"), why_en: str(fd, "why_en"), contested_en: str(fd, "contested_en"),
    title_ur: str(fd, "title_ur"), summary_ur: str(fd, "summary_ur"), why_ur: str(fd, "why_ur"), contested_ur: str(fd, "contested_ur"),
    reviewed_filled: bool(fd, "reviewed_filled"),
  });
  if (!parsed.success) redirect(await withFlash(back, { error: parsed.error.issues.slice(0, 4).map((i) => `${String(i.path[0] ?? "form")}: ${i.message}`).join("; ") }));
  const r = await updateManualStory(user, id, parsed.data);
  if (!r.ok) redirect(await withFlash(back, { error: r.error }));
  revalidatePath(back); revalidatePath("/admin/stories");
  if (r.live) readersSeeIt();
  redirect(await withFlash(back, { ok: ["Saved.", ...r.notes, ...(r.live ? ["It is live on the Editor's desk now."] : [])].join(" ") }));
}

export async function goLiveAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/stories");
  const id = idOf(fd);
  if (!id) redirect(await withFlash("/admin/stories", { error: "Unknown story." }));
  const r = await goLiveNow(user, id);
  if (!r.ok) redirect(await withFlash(`/admin/stories/${id}`, { error: r.error }));
  readersSeeIt(); revalidatePath("/admin/stories");
  redirect(await withFlash(`/admin/stories/${id}`, { ok: "Live on the Editor's desk. It joins the next edition that publishes." }));
}

export async function removeManualStoryAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/stories");
  const id = idOf(fd);
  if (!id) redirect(await withFlash("/admin/stories", { error: "Unknown story." }));
  const r = await removeManualStory(user, id);
  if (!r.ok) redirect(await withFlash(`/admin/stories/${id}`, { error: r.error }));
  revalidatePath("/admin/stories");
  redirect(await withFlash("/admin/stories", { ok: `Removed story ${id} ("${r.title.slice(0, 80)}"). Its link stays in the sources.` }));
}

// ---- jobs and translations (D9, D12) ------------------------------------------------------------

export async function retryJobAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/jobs");
  const back = backTo(fd, "/admin/jobs");
  const id = idOf(fd);
  if (!id) redirect(await withFlash(back, { error: "Unknown job." }));
  const r = await retryJob(user, id);
  revalidatePath("/admin/jobs"); revalidatePath("/admin/translations"); revalidatePath("/admin/stories");
  redirect(await withFlash(back, r.ok ? { ok: r.note } : { error: r.error }));
}

export async function cancelJobAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/jobs");
  const back = backTo(fd, "/admin/jobs");
  const id = idOf(fd);
  if (!id) redirect(await withFlash(back, { error: "Unknown job." }));
  const r = await cancelJob(user, id);
  if (r.ok && r.live) readersSeeIt();
  revalidatePath("/admin/jobs"); revalidatePath("/admin/translations"); revalidatePath("/admin/stories");
  redirect(await withFlash(back, r.ok ? { ok: r.note } : { error: r.error }));
}

/** A translation with no job behind it any more (its job row was removed): queue a fresh one. Otherwise retry its job. */
export async function retryTranslationAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/translations");
  const back = backTo(fd, "/admin/translations");
  const id = idOf(fd);
  if (!id) redirect(await withFlash(back, { error: "Unknown translation." }));
  const [t] = await db.select().from(schema.articleTranslations).where(eq(schema.articleTranslations.id, id));
  if (!t) redirect(await withFlash(back, { error: "That translation no longer exists." }));
  if (t.jobId) {
    const r = await retryJob(user, t.jobId);
    revalidatePath("/admin/translations"); revalidatePath("/admin/jobs");
    redirect(await withFlash(back, r.ok ? { ok: r.note } : { error: r.error }));
  }
  if (t.status === "done") redirect(await withFlash(back, { error: "Readers already have this translation." }));
  // The same rule as retryJob: only a failed translation, or one blocked for a transient reason. A paywall or a
  // robots.txt disallow is final and is never tried harder, even when its job row is gone.
  const transient = t.status === "blocked" && !!t.blockedReason && (RETRYABLE_BLOCKS as readonly string[]).includes(t.blockedReason);
  if (t.status !== "failed" && !transient) {
    redirect(await withFlash(back, { error: t.status === "blocked" ? `Blocked translations are final (${(t.blockedReason ?? "blocked").replace(/_/g, " ")}): the article cannot be had legitimately.` : `The translation is ${t.status}; only failed (or transiently blocked) ones can be retried.` }));
  }
  const job = await db.transaction(async (tx) => {
    // Queued by this editor: the first reader's daily allowance is not spent on it (translations.ts dailyUsage).
    const j = await enqueueJob("translate_article", { item_id: t.itemId, lang: "ur" }, { dedupeKey: jobKeys.translate(t.itemId), requestedBy: user.id, priority: 5, tx });
    // A job that already ended under the key (blocked for good, or done) is left alone, and so is the row:
    // never point a translation at a job that will not run. (Throwing rolls the transaction back.)
    if (j.status !== "queued" && j.status !== "running") return { ...j, refused: true as const };
    const moved = await tx.update(schema.articleTranslations).set({ status: j.status, jobId: j.id, error: null, blockedReason: null, finishedAt: null, updatedAt: new Date() })
      .where(and(eq(schema.articleTranslations.id, id), eq(schema.articleTranslations.status, t.status))).returning({ id: schema.articleTranslations.id });
    if (!moved.length) throw new Error("translation changed meanwhile");
    await writeAudit(tx, user.id, "translation.requeue", `translation:${id}`, { item_id: t.itemId, job_id: j.id });
    return { ...j, refused: false as const };
  }).catch((e: Error) => (e.message === "translation changed meanwhile" ? null : Promise.reject(e)));
  revalidatePath("/admin/translations"); revalidatePath("/admin/jobs");
  if (!job) redirect(await withFlash(back, { error: "The translation changed a moment ago; reload and look again." }));
  if (job.refused) redirect(await withFlash(back, { error: `Its job #${job.id} has already ended (${job.status}); nothing was queued.` }));
  redirect(await withFlash(back, { ok: `Translation queued (job #${job.id}).` }));
}

// ---- reports queue (D8) ------------------------------------------------------------------------

const reportDecision = z.object({ status: z.enum(REPORT_STATUSES), note: z.string().max(REPORT_TEXT_MAX).transform((s) => normalizeUrdu(s)) });

export async function decideReportAction(fd: FormData): Promise<void> {
  const user = await requireAdmin("/admin/reports");
  const back = backTo(fd, "/admin/reports");
  const id = idOf(fd);
  const d = reportDecision.safeParse({ status: str(fd, "status"), note: str(fd, "note") });
  if (!id || !d.success) redirect(await withFlash(back, { error: "Choose resolve, dismiss or reopen (the note is at most 2,000 characters)." }));
  const r = await decideReport(user, id, d.data.status, d.data.note);
  revalidatePath("/admin/reports");
  const verb = d.data.status === "open" ? "reopened" : d.data.status;
  redirect(await withFlash(back, r.ok ? { ok: `Report ${id} ${verb}.` } : { error: r.error }));
}

// ---- X List proposals (D10, owners only) ---------------------------------------------------------

const xDecision = z.object({ group_id: z.coerce.number().int().positive().max(2_147_483_647), list_id: z.string().regex(/^\d{5,25}$/), decision: z.enum(["add", "reject", "reopen"]) });

export async function decideXListAction(fd: FormData): Promise<void> {
  const user = await requireOwner("/admin/groups");
  const d = xDecision.safeParse({ group_id: str(fd, "group_id"), list_id: str(fd, "list_id"), decision: str(fd, "decision") });
  if (!d.success) redirect(await withFlash("/admin/groups", { error: "Unknown group or list." }));
  const back = `/admin/groups/${d.data.group_id}#x-lists`;
  const r = await decideProposal(user, d.data.group_id, d.data.list_id, d.data.decision as Decision);
  revalidatePath(`/admin/groups/${d.data.group_id}`); revalidatePath("/admin/groups");
  redirect(await withFlash(back, r.ok ? { ok: r.note } : { error: r.error }));
}
