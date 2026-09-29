import "server-only";
import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "@/db";
import type { Role } from "./auth/roles";
import { TRANSLATION_BLOCK_REASONS, type TranslationBlockReason, type TranslationStatus } from "./codes";
import { editionClock, storyVisibleSql } from "./desk";
import { enqueueJob, jobByDedupeKey, jobKeys } from "./jobs";

/*
 * Full Urdu translations of cited articles, on a reader's request (decision D9 in docs/PLAN.md): the
 * reader side. The worker does the fetching and translating (docs/API.md § Jobs, `translate_article`);
 * this file decides what may be asked for, queues it, counts each reader's daily requests and reports
 * progress to the article page (app/[locale]/article/[id]).
 *
 * Rules kept here:
 * - Only an item cited by a story readers can see (a published edition, or live on the Editor's desk)
 *   can be translated, and never an Urdu one, nor a video or a channel post (not an article).
 * - One translation per item, kept for every later reader (article_translations, UNIQUE item + lang):
 *   a request for an item that is done, queued, running or blocked makes no new work and costs nothing.
 * - New work (a first request, or asking again after a failure) counts toward the reader's daily limit,
 *   every time: each such request leaves an audit_log row (REQUEST_AUDIT_ACTION), and those are counted.
 *   `blocked` (paywall, robots.txt, unreachable, …) is final: never retried harder.
 * - The text is shown only on its own page to signed-in readers: never in feeds, downloads, search, the
 *   offline cache (public/sw.js keeps only the pages in its READER_PAGE list) or the X board.
 */

type Q = Db | Tx;
const { items, sources, articleTranslations, workerJobs, storySources, stories, editions, settings, auditLog } = schema;

/** Reader-facing work outranks batch work (a manual story's fill or image jobs use 0). */
export const TRANSLATE_PRIORITY = 5;
/** New translations a reader may ask for per day (settings `translate_daily_limit` overrides the reader figure). */
export const TRANSLATE_DAILY_LIMIT = 10;
/** Editors and owners get at least this many. */
export const TRANSLATE_DAILY_LIMIT_STAFF = 25;
/** Sources whose items are not articles: a video page or a channel post has no article text to translate. */
const NOT_ARTICLE_KINDS: ReadonlySet<string> = new Set(["youtube", "telegram"]);
/** A queued request older than this (and well past the usual wait) is "taking longer than usual". */
const STALE_MIN = 10;

const isUrduLang = (lang: string | null | undefined) => !!lang && /^ur(?:[-_]|$)/i.test(lang);

/** An http(s) URL, or null: item URLs come from feeds and are untrusted. */
export function httpHref(u: string | null | undefined): string | null {
  try {
    const url = new URL(String(u ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type ItemForOffer = { url: string; lang: string; langDetected?: string | null; source: { kind: string; lang: string } };

/** Whether an item is in Urdu already: its own language, what was detected, or an Urdu source's when nothing was detected. */
export function itemIsUrdu(item: ItemForOffer): boolean {
  return isUrduLang(item.lang) || isUrduLang(item.langDetected) || (!item.langDetected && isUrduLang(item.source.lang));
}

/** Why an item cannot be offered for translation, or null when it can. */
export function translationRefusal(item: ItemForOffer): "urdu" | "not_article" | null {
  if (itemIsUrdu(item)) return "urdu";
  if (NOT_ARTICLE_KINDS.has(item.source.kind) || !httpHref(item.url)) return "not_article";
  return null;
}

// ---- the story page's source list ------------------------------------------------------------

export type TranslateOffer = { itemId: number; status: TranslationStatus | null; blockedReason: TranslationBlockReason | null };

const asBlockReason = (r: string | null): TranslationBlockReason | null =>
  r && (TRANSLATION_BLOCK_REASONS as readonly string[]).includes(r) ? (r as TranslationBlockReason) : r ? "unreachable" : null;

/**
 * For a story's cited items, the ones that can be offered as "Read the full article in Urdu", with the
 * state of their translation (null: nobody asked yet). Keyed by item URL, as lib/view.ts outletsOf gives it.
 */
export async function translateOffers(cited: { item: ItemForOffer & { id: number } }[]): Promise<Map<string, TranslateOffer>> {
  const offerable = cited.map((c) => c.item).filter((it) => translationRefusal(it) === null);
  const out = new Map<string, TranslateOffer>();
  if (!offerable.length) return out;
  const rows = await db.select({ itemId: articleTranslations.itemId, status: articleTranslations.status, blockedReason: articleTranslations.blockedReason })
    .from(articleTranslations).where(and(inArray(articleTranslations.itemId, offerable.map((i) => i.id)), eq(articleTranslations.lang, "ur")));
  const byItem = new Map(rows.map((r) => [r.itemId, r]));
  for (const it of offerable) {
    if (out.has(it.url)) continue;
    const r = byItem.get(it.id);
    out.set(it.url, { itemId: it.id, status: r?.status ?? null, blockedReason: r?.status === "blocked" ? asBlockReason(r.blockedReason) : null });
  }
  return out;
}

// ---- the article page ------------------------------------------------------------------------

/**
 * The item, the stories readers can see that cite it (newest edition first), and its translation row;
 * null when the item does not exist or no visible story cites it (the page is then a 404).
 */
export async function articleForReader(itemId: number) {
  const [item] = await db.select({
    id: items.id, url: items.url, title: items.title, lang: items.lang, langDetected: items.langDetected,
    publishedAt: items.publishedAt, firstSeenAt: items.firstSeenAt, siteName: items.siteName, author: items.author,
    source: { id: sources.id, name: sources.name, kind: sources.kind, lang: sources.lang, perspective: sources.perspective },
  }).from(items).innerJoin(sources, eq(sources.id, items.sourceId)).where(eq(items.id, itemId));
  if (!item) return null;
  const citing = await db.select({
    id: stories.id, titleEn: stories.titleEn, titleUr: stories.titleUr, deskAt: stories.deskAt,
    date: editions.date, slot: editions.slot, editionStatus: editions.status,
  }).from(storySources).innerJoin(stories, eq(stories.id, storySources.storyId)).innerJoin(editions, eq(editions.id, stories.editionId))
    .where(and(eq(storySources.itemId, itemId), storyVisibleSql))
    .orderBy(desc(editions.date), desc(editions.slot), desc(stories.id)).limit(6);
  if (!citing.length) return null;
  const [translation] = await db.select().from(articleTranslations).where(and(eq(articleTranslations.itemId, itemId), eq(articleTranslations.lang, "ur")));
  return { item, citing, translation: translation ?? null };
}
export type ArticleForReader = NonNullable<Awaited<ReturnType<typeof articleForReader>>>;

/** What the article page's live status shows, and what it polls (lib/translation-actions.ts pollTranslation). */
export type TranslationPoll = {
  status: "none" | TranslationStatus;
  /** Place in the worker's queue while queued: 1 is next. Jobs being worked on count as ahead. */
  position: number | null;
  /** Usual minutes from now until done, from recent translations and the queue ahead; null with no history. */
  waitMin: number | null;
  /** Minutes since this request entered the queue (or was queued again). */
  queuedMin: number | null;
  /** Queued again after an attempt that did not work (the worker retries on its own). */
  retrying: boolean;
  /** Queued much longer than usual: the translator may be busy or switched off. */
  stale: boolean;
  blockedReason: TranslationBlockReason | null;
};

/** Median minutes a translation took from the worker claiming it to done, over recent ones; null without history. */
async function typicalWorkMin(q: Q = db): Promise<number | null> {
  const rows = (await q.execute(sql`select percentile_cont(0.5) within group (order by w.sec) as sec from (
      select extract(epoch from (finished_at - started_at)) as sec from worker_jobs
      where kind = 'translate_article' and status = 'done' and started_at is not null and finished_at > now() - interval '30 days'
      order by finished_at desc limit 30) w`)) as unknown as { sec: string | number | null }[];
  const sec = rows[0]?.sec == null ? null : Number(rows[0].sec);
  return sec != null && Number.isFinite(sec) && sec > 0 ? sec / 60 : null;
}

/** The translation's state for the page and its poll: the row, then the job behind it for the queue position. */
export async function translationPoll(itemId: number, q: Q = db): Promise<TranslationPoll> {
  const [tr] = await q.select({ status: articleTranslations.status, blockedReason: articleTranslations.blockedReason })
    .from(articleTranslations).where(and(eq(articleTranslations.itemId, itemId), eq(articleTranslations.lang, "ur")));
  const job = await jobByDedupeKey(jobKeys.translate(itemId), q);
  const base: TranslationPoll = { status: tr?.status ?? "none", position: null, waitMin: null, queuedMin: null, retrying: false, stale: false, blockedReason: null };
  if (!tr) return base;
  if (tr.status === "blocked") return { ...base, blockedReason: asBlockReason(tr.blockedReason) ?? "unreachable" };
  if (tr.status !== "queued" && tr.status !== "running") return base;
  const work = await typicalWorkMin(q);
  if (!job || (job.status !== "queued" && job.status !== "running")) {
    // The row says waiting but its job ended (a moment ago, or the row is behind): report the job's end.
    const status = job?.status === "done" ? "done" : job?.status === "blocked" ? "blocked" : job?.status === "failed" ? "failed" : tr.status;
    return { ...base, status, waitMin: work == null ? null : Math.max(1, Math.round(work)) };
  }
  const now = Date.now();
  const since = Math.max(job.createdAt.getTime(), Math.min(job.runAfter.getTime(), now));
  const queuedMin = Math.max(0, (now - since) / 60_000);
  if (job.status === "running") {
    const running = job.startedAt ? (now - job.startedAt.getTime()) / 60_000 : 0;
    return { ...base, status: "running", queuedMin, waitMin: work == null ? null : Math.max(1, Math.round(work - Math.min(running, work * 0.9))), retrying: job.attempts > 1 };
  }
  // Queued: jobs being worked on, and queued ones the worker takes first (priority, then age), are ahead.
  const [p] = await q.select({ ahead: sql<number>`count(*)::int` }).from(workerJobs).where(and(
    ne(workerJobs.id, job.id), inArray(workerJobs.status, ["queued", "running"]),
    or(eq(workerJobs.status, "running"), and(sql`${workerJobs.runAfter} <= now()`, or(
      sql`${workerJobs.priority} > ${TRANSLATE_PRIORITY}`,
      and(eq(workerJobs.priority, TRANSLATE_PRIORITY), sql`${workerJobs.id} < ${job.id}`),
    ))),
  ));
  const position = (p?.ahead ?? 0) + 1;
  const waitMin = work == null ? null : Math.max(1, Math.round(work * position));
  const stale = queuedMin > Math.max(STALE_MIN, (waitMin ?? 0) * 3);
  return { ...base, status: "queued", position, waitMin, queuedMin, retrying: job.attempts > 0, stale };
}

// ---- requests and the daily limit ---------------------------------------------------------------

/** Midnight today in the edition clock's time zone (settings `timezone`, else Asia/Karachi). */
async function startOfToday(q: Q): Promise<Date> {
  const { tz } = await editionClock(q);
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const y = Number(parts.year), m = Number(parts.month) - 1, d = Number(parts.day);
  const offset = Date.UTC(y, m, d, Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(y, m, d) - offset);
}

/** The reader's daily allowance: settings `translate_daily_limit` (0–1000) for readers, at least the staff figure for editors and owners. */
async function dailyLimit(role: Role, q: Q): Promise<number> {
  const [row] = await q.select({ value: settings.value }).from(settings).where(eq(settings.key, "translate_daily_limit"));
  const n = Number(row?.value);
  const reader = Number.isInteger(n) && n >= 0 && n <= 1000 ? n : TRANSLATE_DAILY_LIMIT;
  return role === "reader" ? reader : Math.max(reader, TRANSLATE_DAILY_LIMIT_STAFF);
}

/** audit_log action written for every request that made new translation work (what the daily limit counts); "reader." keeps it apart from the editors' actions the admin lists. */
export const REQUEST_AUDIT_ACTION = "reader.translate_request";

/**
 * New translation work the reader's requests made today (since local midnight). Every request that
 * queued work (a first request, or asking again after a failure) leaves an audit_log row, and each row
 * counts: counting jobs instead would let a reader ask again and again for one failing article (each ask
 * revives the same job row with fresh attempts, and each attempt may spend the daily usage budget the
 * editions need). Jobs they created today also count, in case a row is missing (the larger figure wins).
 * The worker retrying a job after midnight, or an editor re-queueing one in the admin, costs the reader
 * nothing.
 */
export async function dailyUsage(user: { id: number; role: Role }, q: Q = db): Promise<{ used: number; limit: number }> {
  const since = await startOfToday(q);
  const [[asked], [made], limit] = await Promise.all([
    q.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(and(
      eq(auditLog.userId, user.id), eq(auditLog.action, REQUEST_AUDIT_ACTION), gte(auditLog.at, since),
    )),
    q.select({ n: sql<number>`count(*)::int` }).from(workerJobs).where(and(
      eq(workerJobs.requestedBy, user.id), eq(workerJobs.kind, "translate_article"), gte(workerJobs.createdAt, since),
    )),
    dailyLimit(user.role, q),
  ]);
  return { used: Math.max(asked?.n ?? 0, made?.n ?? 0), limit };
}

export type RequestError = "not_found" | "urdu" | "not_article" | "limit";
export type RequestOutcome = { ok: true; status: TranslationStatus; created: boolean } | { ok: false; error: RequestError; limit?: number };

/** Namespace for the per-reader advisory lock that serialises one reader's requests (the limit check and the insert). */
const LOCK_NS = 0x7442_0009;

/**
 * A signed-in reader asks for the full Urdu translation of a cited item. Done, queued, running and
 * blocked translations are returned as they are (no new work, nothing counted). A first request, or one
 * after a failure, queues a `translate_article` job and its article_translations row in one transaction,
 * if the reader is under today's limit.
 */
export async function requestTranslation(user: { id: number; role: Role }, itemId: number): Promise<RequestOutcome> {
  const art = await articleForReader(itemId);
  if (!art) return { ok: false, error: "not_found" };
  const refusal = translationRefusal(art.item);
  if (refusal) return { ok: false, error: refusal };
  if (art.translation && art.translation.status !== "failed") return { ok: true, status: art.translation.status, created: false };
  return db.transaction(async (tx): Promise<RequestOutcome> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NS}, ${user.id})`);
    // Another reader may have asked a moment ago: their request is ours too, at no cost.
    const [now] = await tx.select({ status: articleTranslations.status }).from(articleTranslations)
      .where(and(eq(articleTranslations.itemId, itemId), eq(articleTranslations.lang, "ur")));
    if (now && now.status !== "failed") return { ok: true, status: now.status, created: false };
    const { used, limit } = await dailyUsage(user, tx);
    if (used >= limit) return { ok: false, error: "limit", limit };
    const job = await enqueueJob("translate_article", { item_id: itemId, lang: "ur" }, {
      dedupeKey: jobKeys.translate(itemId), requestedBy: user.id, priority: TRANSLATE_PRIORITY, tx,
    });
    // A job that already ended (done or blocked) while its row says failed is left alone: never write a
    // "done" row without its text. The page shows the row's state.
    if (job.status !== "queued" && job.status !== "running") return { ok: true, status: now?.status ?? "failed", created: false };
    const status: TranslationStatus = job.status;
    const at = new Date();
    // The first requester stays on the row; asking again after a failure only resets its state.
    await tx.insert(articleTranslations).values({ itemId, lang: "ur", status, requestedBy: user.id, jobId: job.id })
      .onConflictDoUpdate({
        target: [articleTranslations.itemId, articleTranslations.lang],
        set: { status, jobId: job.id, error: null, blockedReason: null, finishedAt: null, updatedAt: at },
        setWhere: sql`${articleTranslations.status} = 'failed'`,
      });
    const made = job.created || job.requeued;
    // What the daily limit counts (dailyUsage), in the same transaction as the work it made. Targeted at
    // the item, not the job: the admin's history lists (auditFor on job:/translation:) never show readers.
    if (made) {
      await tx.insert(auditLog).values({
        userId: user.id, action: REQUEST_AUDIT_ACTION, target: `item:${itemId}`, detail: { job_id: job.id, requeued: job.requeued }, at,
      });
    }
    return { ok: true, status, created: made };
  });
}
