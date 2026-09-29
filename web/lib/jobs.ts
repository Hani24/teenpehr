import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "@/db";
import {
  fillLanguagePayload, jobPayloadSchemas, parseJobResult, storyImagePayload, translateArticlePayload,
  type JobFailIn, type JobPayloadIn, type JobResult,
} from "./contracts";
import type { JobKind, JobStatus, StoryLang } from "./codes";
import { goLiveIfReady } from "./desk";
import { EDITIONS_TAG } from "./cache-tags";
import { normalizeUrdu } from "./urdu";

/*
 * Worker jobs (docs/API.md § Jobs): work the site asks of the worker between editions (D9 full-article
 * translations, D12 manual-story language fill and image). The site enqueues with enqueueJob(); the worker
 * claims one (claimJob: FOR UPDATE SKIP LOCKED, a lease in locked_until), reads jobContext(), and reports
 * finishJob() or failJob(). A result is validated per kind (lib/contracts.ts jobResultSchemas) and applied
 * to its target in the same transaction that marks the job done.
 *
 * Lifecycle: queued → running (claimed; attempts + 1) → done | blocked | failed, or back to queued after a
 * retryable failure (run_after backoff). A running job whose lease expired is claimable again while
 * attempts remain, and failed once they are used up. `blocked` is final: the work cannot be done
 * legitimately (paywall, robots.txt, …) and is never retried harder.
 */

type Q = Db | Tx;
const { workerJobs, articleTranslations, stories, editions, items, sources, groups, images, storySources, storyPosts, glossary } = schema;
export type JobRow = typeof workerJobs.$inferSelect;

// ---- site side -----------------------------------------------------------------------------

export type EnqueueOptions = {
  /** Unique when set: a second request with the same key finds the job the first one made. */
  dedupeKey?: string | null;
  /** The reader or editor whose request made the job (per-reader daily limits count these). */
  requestedBy?: number | null;
  /** Higher is claimed first. Reader-facing work (a translation someone is waiting for) should outrank batch work. */
  priority?: number;
  maxAttempts?: number;
  /** A job with this dedupe key that failed for good is queued again (fresh attempts). Default true. */
  requeueFailed?: boolean;
  /** Run inside the caller's transaction (a manual story and its jobs commit together). */
  tx?: Q;
};

/**
 * Queue a job. The payload is validated for its kind (a bad one throws: it is a programming error). With a
 * dedupe key, an existing job is returned instead (`created: false`); one that failed for good is queued
 * again with fresh attempts (`requeued: true`) unless `requeueFailed` is false. Blocked and done jobs are
 * never requeued here. `created || requeued` means this call caused new work (count it against a limit).
 */
export async function enqueueJob<K extends JobKind>(kind: K, payload: JobPayloadIn<K>, opts: EnqueueOptions = {}): Promise<{ id: number; status: JobStatus; created: boolean; requeued: boolean }> {
  const q = opts.tx ?? db;
  const data = jobPayloadSchemas[kind].parse(payload) as Record<string, unknown>;
  const row = {
    kind, payload: data, dedupeKey: opts.dedupeKey ?? null, requestedBy: opts.requestedBy ?? null,
    priority: opts.priority ?? 0, maxAttempts: opts.maxAttempts ?? 3,
  };
  if (!row.dedupeKey) {
    const [j] = await q.insert(workerJobs).values(row).returning({ id: workerJobs.id, status: workerJobs.status });
    return { ...j, created: true, requeued: false };
  }
  const requeue = opts.requeueFailed ?? true;
  const now = new Date();
  const [j] = await q.insert(workerJobs).values(row).onConflictDoUpdate({
    target: workerJobs.dedupeKey,
    set: {
      status: "queued", payload: data, attempts: 0, maxAttempts: row.maxAttempts, priority: row.priority, requestedBy: row.requestedBy,
      runAfter: now, lockedBy: null, lockedUntil: null, result: null, error: null, startedAt: null, finishedAt: null, updatedAt: now,
    },
    // Only a job that failed for good is revived; the xmax test tells an insert from that update.
    setWhere: requeue ? sql`${workerJobs.status} = 'failed'` : sql`false`,
  }).returning({ id: workerJobs.id, status: workerJobs.status, inserted: sql<boolean>`(xmax = 0)` });
  if (j) return { id: j.id, status: j.status, created: j.inserted, requeued: !j.inserted };
  const [existing] = await q.select({ id: workerJobs.id, status: workerJobs.status }).from(workerJobs).where(eq(workerJobs.dedupeKey, row.dedupeKey));
  if (!existing) throw new Error(`job ${row.dedupeKey} vanished`);
  return { ...existing, created: false, requeued: false };
}

export type JobView = Pick<JobRow, "id" | "kind" | "status" | "attempts" | "maxAttempts" | "error" | "result" | "payload" | "requestedBy" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt" | "runAfter">;
const jobViewCols = {
  id: workerJobs.id, kind: workerJobs.kind, status: workerJobs.status, attempts: workerJobs.attempts, maxAttempts: workerJobs.maxAttempts,
  error: workerJobs.error, result: workerJobs.result, payload: workerJobs.payload, requestedBy: workerJobs.requestedBy,
  createdAt: workerJobs.createdAt, updatedAt: workerJobs.updatedAt, startedAt: workerJobs.startedAt, finishedAt: workerJobs.finishedAt, runAfter: workerJobs.runAfter,
};

/** A job's state (for a page that polls "translating…"), or null. */
export async function jobStatus(id: number, q: Q = db): Promise<JobView | null> {
  const [j] = await q.select(jobViewCols).from(workerJobs).where(eq(workerJobs.id, id));
  return j ?? null;
}

/** The job made under a dedupe key, or null. */
export async function jobByDedupeKey(key: string, q: Q = db): Promise<JobView | null> {
  const [j] = await q.select(jobViewCols).from(workerJobs).where(eq(workerJobs.dedupeKey, key));
  return j ?? null;
}

/** Jobs for one manual story (fill_language, story_image), newest first: what the admin shows beside it. */
export async function jobsForStory(storyId: number, q: Q = db): Promise<JobView[]> {
  return q.select(jobViewCols).from(workerJobs)
    .where(and(inArray(workerJobs.kind, ["fill_language", "story_image"]), sql`${workerJobs.payload}->>'story_id' = ${String(storyId)}`))
    .orderBy(desc(workerJobs.id));
}

/** Dedupe keys the site uses, so every caller spells them the same way. */
export const jobKeys = {
  translate: (itemId: number, lang: "ur" = "ur") => `translate:${itemId}:${lang}`,
  fill: (storyId: number, lang: StoryLang) => `fill:${storyId}:${lang}`,
  image: (storyId: number) => `image:${storyId}`,
};

/** Jobs a user's requests made since `since` (per-reader daily limits, D9). */
export async function jobsRequestedSince(userId: number, kind: JobKind, since: Date, q: Q = db): Promise<number> {
  const [r] = await q.select({ n: sql<number>`count(*)::int` }).from(workerJobs)
    .where(and(eq(workerJobs.requestedBy, userId), eq(workerJobs.kind, kind), sql`${workerJobs.createdAt} >= ${since.toISOString()}::timestamptz`));
  return r?.n ?? 0;
}

// ---- worker side (app/api/worker/jobs/**) ------------------------------------------------------

export class JobError extends Error {
  constructor(message: string, readonly code: 400 | 404 | 409, readonly issues?: unknown) { super(message); }
}

/**
 * Claim the next job of one of `kinds` for `workerId`, or null. First, running jobs whose lease ran out
 * with no attempts left are failed (and their targets told). Then one queued job whose run_after has come,
 * or one running job whose lease ran out, is taken (priority, then age) with FOR UPDATE SKIP LOCKED, so
 * two workers never get the same job.
 */
export async function claimJob(kinds: JobKind[], workerId: string, leaseS: number): Promise<JobRow | null> {
  const now = new Date();
  const wentLive = await db.transaction(async (tx) => {
    const dead = await tx.update(workerJobs).set({
      status: "failed", error: sql`coalesce(${workerJobs.error} || ' / ', '') || 'lease expired with no attempts left'`,
      lockedBy: null, lockedUntil: null, finishedAt: now, updatedAt: now,
    }).where(and(eq(workerJobs.status, "running"), lt(workerJobs.lockedUntil, now), sql`${workerJobs.attempts} >= ${workerJobs.maxAttempts}`))
      .returning();
    let live = false;
    for (const j of dead) {
      await afterFinalFailure(tx, j, { status: "failed", error: "lease expired with no attempts left" });
      const storyId = storyOf(j);
      if (storyId && (await goLiveIfReady(tx, storyId))) live = true;
    }
    return live;
  });
  if (wentLive) expireReaderPages();
  return db.transaction(async (tx) => {
    const next = tx.select({ id: workerJobs.id }).from(workerJobs)
      .where(and(inArray(workerJobs.kind, kinds), or(
        and(eq(workerJobs.status, "queued"), lte(workerJobs.runAfter, now)),
        and(eq(workerJobs.status, "running"), lt(workerJobs.lockedUntil, now), sql`${workerJobs.attempts} < ${workerJobs.maxAttempts}`),
      )))
      .orderBy(desc(workerJobs.priority), asc(workerJobs.id)).limit(1).for("update", { skipLocked: true });
    const [job] = await tx.update(workerJobs).set({
      status: "running", attempts: sql`${workerJobs.attempts} + 1`, lockedBy: workerId,
      lockedUntil: new Date(now.getTime() + leaseS * 1000), startedAt: sql`coalesce(${workerJobs.startedAt}, now())`, updatedAt: now,
    }).where(inArray(workerJobs.id, next)).returning();
    if (!job) return null;
    if (job.kind === "translate_article") {
      const p = translateArticlePayload.safeParse(job.payload);
      if (p.success) await tx.update(articleTranslations).set({ status: "running", jobId: job.id, updatedAt: now })
        .where(and(eq(articleTranslations.itemId, p.data.item_id), eq(articleTranslations.lang, p.data.lang), inArray(articleTranslations.status, ["queued", "failed"])));
    }
    return job;
  });
}

/** Lock a job for a report from `workerId`; the checks every report shares. */
async function lockForReport(tx: Tx, id: number, workerId: string | undefined): Promise<JobRow | { already: JobStatus }> {
  const [job] = await tx.select().from(workerJobs).where(eq(workerJobs.id, id)).for("update");
  if (!job) throw new JobError("job not found", 404);
  if (job.status === "done" || job.status === "blocked") return { already: job.status };
  if (job.status !== "running") throw new JobError(`job is ${job.status}, not running (claim it first)`, 409);
  if (workerId && job.lockedBy && job.lockedBy !== workerId) throw new JobError("another worker holds this job's lease (yours expired)", 409);
  return job;
}

export type FinishOutcome = { status: JobStatus; applied: boolean; note?: string; already?: boolean };

/**
 * POST /jobs/{id}/done: validate `result` for the job's kind and apply it. A result that cannot be applied
 * (its story went live meanwhile, say) fails the job for good with the reason (`applied: false`); the
 * worker should not retry. A report for a job already done or blocked changes nothing (`already`).
 */
export async function finishJob(id: number, workerId: string | undefined, rawResult: unknown): Promise<FinishOutcome> {
  let expire = false;
  const out = await db.transaction(async (tx): Promise<FinishOutcome> => {
    const job = await lockForReport(tx, id, workerId);
    if ("already" in job) return { status: job.already, applied: true, already: true };
    const parsed = parseJobResult(job.kind, rawResult);
    if (!parsed.success) {
      throw new JobError("result does not match the job's kind", 400, parsed.error.issues.slice(0, 20).map((i) => ({ path: ["result", ...i.path].join("."), message: i.message })));
    }
    const now = new Date();
    let applied: Applied;
    switch (job.kind) {
      case "translate_article": applied = await applyTranslation(tx, job, parsed.data as JobResult<"translate_article">); break;
      case "fill_language": applied = await applyFill(tx, job, parsed.data as JobResult<"fill_language">); break;
      case "story_image": applied = await applyImage(tx, job, parsed.data as JobResult<"story_image">); break;
    }
    const status: JobStatus = !applied.ok ? "failed" : applied.blocked ? "blocked" : "done";
    await tx.update(workerJobs).set({
      status, result: applied.stored, error: applied.ok ? null : `not applied: ${applied.note}`,
      lockedBy: null, lockedUntil: null, finishedAt: now, updatedAt: now,
    }).where(eq(workerJobs.id, id));
    // A manual story waits for its jobs (lib/desk.ts manualNotReady): with this one finished it may go live.
    const storyId = storyOf(job);
    if (storyId && (await goLiveIfReady(tx, storyId))) expire = true;
    return { status, applied: applied.ok, ...(applied.note ? { note: applied.note } : {}) };
  });
  if (expire) expireReaderPages();
  return out;
}

/**
 * POST /jobs/{id}/fail. `blocked`: final (the target is told why). `retry` with attempts left: queued again
 * after `retry_after_s` or a backoff of 1, 2, 4 … minutes (at most an hour). Otherwise failed for good.
 */
export async function failJob(id: number, workerId: string | undefined, f: JobFailIn): Promise<{ status: JobStatus; already?: boolean; retry_at?: string }> {
  let expire = false;
  const out = await db.transaction(async (tx) => {
    const job = await lockForReport(tx, id, workerId);
    if ("already" in job) return { status: job.already, already: true };
    const now = new Date();
    const error = f.error.slice(0, 4000);
    if (!f.blocked && f.retry && job.attempts < job.maxAttempts) {
      const wait = f.retry_after_s ?? Math.min(3600, 60 * 2 ** Math.max(0, job.attempts - 1));
      const runAfter = new Date(now.getTime() + wait * 1000);
      await tx.update(workerJobs).set({ status: "queued", error, runAfter, lockedBy: null, lockedUntil: null, updatedAt: now }).where(eq(workerJobs.id, id));
      if (job.kind === "translate_article") await setTranslation(tx, job, { status: "queued", error, updatedAt: now });
      return { status: "queued" as const, retry_at: runAfter.toISOString() };
    }
    const status = f.blocked ? "blocked" as const : "failed" as const;
    await tx.update(workerJobs).set({ status, error, lockedBy: null, lockedUntil: null, finishedAt: now, updatedAt: now }).where(eq(workerJobs.id, id));
    await afterFinalFailure(tx, job, { status, error, reason: f.reason });
    const storyId = storyOf(job);
    if (storyId && (await goLiveIfReady(tx, storyId))) expire = true; // a failed image no longer holds a desk story back
    return { status };
  });
  if (expire) expireReaderPages();
  return out;
}

/** Tell a job's target that it ended without a result. */
async function afterFinalFailure(tx: Tx, job: JobRow, e: { status: "failed" | "blocked"; error: string; reason?: string }) {
  if (job.kind === "translate_article") {
    await setTranslation(tx, job, {
      status: e.status, error: e.error, blockedReason: e.status === "blocked" ? (e.reason ?? "unreachable") : null,
      finishedAt: new Date(), updatedAt: new Date(),
    });
  }
  // fill_language: the story keeps its missing side (still not ready; the admin shows the failed job).
  // story_image: the story simply has no image.
}

async function setTranslation(tx: Tx, job: JobRow, set: Partial<typeof articleTranslations.$inferInsert>) {
  const p = translateArticlePayload.safeParse(job.payload);
  if (!p.success) return;
  await tx.update(articleTranslations).set(set)
    .where(and(eq(articleTranslations.itemId, p.data.item_id), eq(articleTranslations.lang, p.data.lang), sql`${articleTranslations.status} <> 'done'`));
}

function storyOf(job: JobRow): number | null {
  if (job.kind === "fill_language") { const p = fillLanguagePayload.safeParse(job.payload); return p.success ? p.data.story_id : null; }
  if (job.kind === "story_image") { const p = storyImagePayload.safeParse(job.payload); return p.success ? p.data.story_id : null; }
  return null;
}

function expireReaderPages() {
  revalidateTag(EDITIONS_TAG, { expire: 0 });
  revalidatePath("/", "layout");
}

// ---- result handlers -----------------------------------------------------------------------

/** `stored`: what the job row keeps as its result (a translation's text lives in article_translations only). */
type Applied = { ok: true; blocked?: boolean; stored: Record<string, unknown>; note?: string } | { ok: false; note: string; stored: Record<string, unknown> };
const usageOf = (r: { model: string; tokens_in: number; tokens_out: number; cost_usd: number }) =>
  ({ model: r.model, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost_usd: r.cost_usd });

async function applyTranslation(tx: Tx, job: JobRow, r: JobResult<"translate_article">): Promise<Applied> {
  const p = translateArticlePayload.parse(job.payload);
  const [item] = await tx.select({ id: items.id }).from(items).where(eq(items.id, p.item_id));
  if (!item) return { ok: false, note: `item ${p.item_id} not found`, stored: usageOf(r) };
  const now = new Date();
  // `key` only on insert; on conflict the row keeps its item, language and first requester.
  const key = { itemId: p.item_id, lang: p.lang, requestedBy: job.requestedBy };
  const base = {
    jobId: job.id, model: r.model || null,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd.toFixed(6), finishedAt: now, updatedAt: now,
  };
  if ("blocked" in r) {
    const set = { ...base, status: "blocked" as const, blockedReason: r.blocked.reason, error: r.blocked.note || null };
    // A translation readers already have stays when a later attempt (the article changed, say) is blocked.
    await tx.insert(articleTranslations).values({ ...key, ...set }).onConflictDoUpdate({
      target: [articleTranslations.itemId, articleTranslations.lang], set, setWhere: sql`${articleTranslations.status} <> 'done'`,
    });
    return { ok: true, blocked: true, stored: { blocked: r.blocked, ...usageOf(r) } };
  }
  const set = {
    ...base, status: "done" as const, title: normalizeUrdu(r.title), body: normalizeUrdu(r.body), sourceTextHash: r.source_text_hash ?? null,
    sourceWords: r.source_words, checkOk: r.check_ok, checkNote: r.check_note, error: null, blockedReason: null,
  };
  await tx.insert(articleTranslations).values({ ...key, ...set }).onConflictDoUpdate({ target: [articleTranslations.itemId, articleTranslations.lang], set });
  return { ok: true, stored: { source_words: r.source_words, check_ok: r.check_ok, check_note: r.check_note, chars: r.body.length, ...usageOf(r) } };
}

/** English words a story shows and the time to read them at 220 a minute (the edition PUT's rule). */
function readingStats(s: { titleEn: string; summaryEn: string; whyEn: string; contestedEn: string }) {
  const words = `${s.titleEn} ${s.summaryEn} ${s.whyEn} ${s.contestedEn}`.split(/\s+/).filter(Boolean).length;
  return { wordCount: words, readingTimeSec: Math.ceil((words * 60) / 220) };
}

const FILL_FIELDS = ["title", "summary", "why", "contested"] as const;

/** Fill the payload's language from the result, only where the story's field is empty (never over an editor's text). */
async function applyFill(tx: Tx, job: JobRow, r: JobResult<"fill_language">): Promise<Applied> {
  const p = fillLanguagePayload.parse(job.payload);
  const fields = r.fields[p.lang];
  if (!fields) throw new JobError(`result.fields.${p.lang} is required for this job`, 400);
  const [s] = await tx.select({ story: stories, status: editions.status }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId))
    .where(eq(stories.id, p.story_id)).for("update", { of: stories });
  const stored = { lang: p.lang, fields: r.fields, ...usageOf(r) };
  if (!s) return { ok: false, note: `story ${p.story_id} not found`, stored };
  if (s.story.origin !== "manual") return { ok: false, note: "not a manual story", stored };
  if (s.status === "published" || s.story.deskAt) return { ok: false, note: "the story is live: never edited after publication", stored };
  const suffix = p.lang === "en" ? "En" : "Ur";
  const set: Record<string, string> = {};
  for (const f of FILL_FIELDS) {
    const col = `${f}${suffix}` as `${(typeof FILL_FIELDS)[number]}${"En" | "Ur"}`;
    const value = p.lang === "ur" ? normalizeUrdu(fields[f]) : fields[f];
    if (s.story[col] === "" && value !== "") set[col] = value;
  }
  if (!Object.keys(set).length) return { ok: true, note: "nothing to fill: the editor wrote every field", stored };
  const next = { ...s.story, ...set };
  await tx.update(stories).set({ ...set, languageFilled: p.lang, ...(p.lang === "en" ? readingStats(next) : {}) }).where(eq(stories.id, p.story_id));
  return { ok: true, stored };
}

/** Attach the uploaded image when it belongs to an item or post the story cites and the story has none yet. */
async function applyImage(tx: Tx, job: JobRow, r: JobResult<"story_image">): Promise<Applied> {
  const p = storyImagePayload.parse(job.payload);
  const stored = { image_id: r.image_id, note: r.note };
  if (r.image_id == null) return { ok: true, note: r.note || "no usable image", stored };
  const [s] = await tx.select({ imageId: stories.imageId, deskAt: stories.deskAt, status: editions.status }).from(stories)
    .innerJoin(editions, eq(editions.id, stories.editionId)).where(eq(stories.id, p.story_id)).for("update", { of: stories });
  if (!s) return { ok: false, note: `story ${p.story_id} not found`, stored };
  if (s.status === "published" || s.deskAt) return { ok: false, note: "the story is live: never changed after publication", stored };
  if (s.imageId != null) return { ok: true, note: "the story already has an image (an editor's choice stays)", stored };
  const [img] = await tx.select({ id: images.id, itemId: images.itemId, postId: images.postId }).from(images).where(eq(images.id, r.image_id));
  if (!img) throw new JobError(`image ${r.image_id} not found (upload it with POST /api/worker/images first)`, 400);
  const cited = img.itemId != null
    ? (await tx.select({ one: sql`1` }).from(storySources).where(and(eq(storySources.storyId, p.story_id), eq(storySources.itemId, img.itemId)))).length > 0
    : (await tx.select({ one: sql`1` }).from(storyPosts).where(and(eq(storyPosts.storyId, p.story_id), eq(storyPosts.postId, img.postId!)))).length > 0;
  if (!cited) throw new JobError("image not from an item or post the story cites", 400);
  await tx.update(stories).set({ imageId: img.id }).where(eq(stories.id, p.story_id));
  return { ok: true, stored };
}

// ---- context -----------------------------------------------------------------------------------

/** Locked glossary spellings, as the Urdu passes use them. */
async function lockedGlossary(q: Q) {
  const rows = await q.select({ term_en: glossary.termEn, term_ur: glossary.termUr, kind: glossary.kind }).from(glossary)
    .where(eq(glossary.locked, true)).orderBy(asc(glossary.termEn));
  return rows;
}

/** An item as a job needs it: where to fetch it and whose it is. */
async function itemContext(q: Q, itemId: number) {
  const [row] = await q.select({
    id: items.id, url: items.url, url_canonical: items.urlCanonical, title: items.title, lang: items.lang, published_at: items.publishedAt,
    description: items.description, image_url: items.imageUrl, site_name: items.siteName, author: items.author,
    source: { id: sources.id, name: sources.name, kind: sources.kind, route: sources.route, lang: sources.lang, url: sources.url, perspective: sources.perspective, fetcher_tier: sources.fetcherTier },
  }).from(items).innerJoin(sources, eq(sources.id, items.sourceId)).where(eq(items.id, itemId));
  return row ?? null;
}

/**
 * GET /jobs/{id}/context: everything the worker needs for one job, so it never reads the database. Fetched
 * text is still untrusted data to the worker, and so is every story field here (an editor's text included).
 */
export async function jobContext(id: number) {
  const [job] = await db.select().from(workerJobs).where(eq(workerJobs.id, id));
  if (!job) throw new JobError("job not found", 404);
  const head = { id: job.id, kind: job.kind, status: job.status, payload: job.payload, attempts: job.attempts, max_attempts: job.maxAttempts, locked_by: job.lockedBy, locked_until: job.lockedUntil };
  const glossaryLocked = await lockedGlossary(db);
  if (job.kind === "translate_article") {
    const p = translateArticlePayload.parse(job.payload);
    const item = await itemContext(db, p.item_id);
    if (!item) throw new JobError(`item ${p.item_id} not found`, 404);
    const [t] = await db.select({ status: articleTranslations.status, source_text_hash: articleTranslations.sourceTextHash, finished_at: articleTranslations.finishedAt })
      .from(articleTranslations).where(and(eq(articleTranslations.itemId, p.item_id), eq(articleTranslations.lang, p.lang)));
    return { job: head, item, translation: t ?? null, glossary: glossaryLocked };
  }
  const p = job.kind === "fill_language" ? fillLanguagePayload.parse(job.payload) : storyImagePayload.parse(job.payload);
  const [s] = await db.select({
    id: stories.id, origin: stories.origin, placement: stories.placement, tag: stories.tag,
    title_en: stories.titleEn, title_ur: stories.titleUr, summary_en: stories.summaryEn, summary_ur: stories.summaryUr,
    why_en: stories.whyEn, why_ur: stories.whyUr, contested_en: stories.contestedEn, contested_ur: stories.contestedUr,
    language_filled: stories.languageFilled, created_by_name: stories.createdByName, image_id: stories.imageId, desk_at: stories.deskAt,
    edition_status: editions.status, group: { slug: groups.slug, name_en: groups.nameEn, name_ur: groups.nameUr },
  }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId)).innerJoin(groups, eq(groups.id, stories.groupId)).where(eq(stories.id, p.story_id));
  if (!s) throw new JobError(`story ${p.story_id} not found`, 404);
  const cited = await db.select({ item_id: storySources.itemId, is_primary: storySources.isPrimary }).from(storySources).where(eq(storySources.storyId, p.story_id));
  const citedItems = (await Promise.all(cited.map(async (c) => ({ ...(await itemContext(db, c.item_id)), is_primary: c.is_primary })))).filter((c) => c.id != null);
  if (job.kind === "fill_language") return { job: head, story: s, sources: citedItems, glossary: glossaryLocked };
  const item = await itemContext(db, (p as { item_id: number }).item_id);
  if (!item) throw new JobError(`item ${(p as { item_id: number }).item_id} not found`, 404);
  return { job: head, story: s, item, sources: citedItems };
}

/** A claimed job as the API returns it. */
export function jobJson(j: JobRow) {
  return {
    id: j.id, kind: j.kind, payload: j.payload, priority: j.priority, attempts: j.attempts, max_attempts: j.maxAttempts,
    locked_by: j.lockedBy, locked_until: j.lockedUntil, requested_by: j.requestedBy, created_at: j.createdAt,
  };
}
