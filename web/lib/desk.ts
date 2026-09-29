import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "@/db";
import { SLOTS, TZ, type Slot } from "./urdu";

/*
 * Manual stories and the Editor's desk (decision D12 in docs/PLAN.md).
 *
 * Every story row belongs to an edition row (stories.edition_id stays NOT NULL), so reader queries keep
 * their shape. A manual story (stories.origin = 'manual', qa_status 'manual') has a placement:
 *
 * - `edition`: it sits in the edition the editor chose (the upcoming one, or a held one) and goes out
 *   when that edition publishes. The worker's edition PUT keeps manual stories (it replaces only
 *   origin 'ai' ones) and keeps an edition_groups row for their groups (ensureEditionGroups).
 * - `desk`: it is "published now" on the front page's Editor's desk strip. It is hosted in the upcoming
 *   unpublished edition row, and `desk_at` records when it went live; from then on it is immutable like a
 *   published story. Readers see it on the strip (getDeskStories in lib/queries.ts) and on its story page
 *   while its edition is unpublished. When ANY edition publishes, every live desk story sitting in another
 *   unpublished edition moves into the one being published (joinDeskStories, called inside the publish
 *   transaction), so "it joins the next edition that publishes" holds even when a slot is skipped or a held
 *   edition is released first. Once its edition is published it leaves the strip.
 *
 * A manual story is not ready while it misses a language (the worker fills that side from the editor's own
 * text: fill_language job) or while a fill_language or story_image job for it is still queued or running
 * (manualNotReady). A desk story goes live (desk_at) only once ready (goLiveIfReady, which lib/jobs.ts calls
 * after each of its jobs ends). If an edition publishes while one of its manual stories is not ready, that
 * story moves to the upcoming edition instead of going out half-made (never edited after publication).
 */

type Q = Db | Tx;

/** The slot after (date, slot): subh → dopahar → shaam → the next day's subh. */
export function followingSlot(date: string, slot: Slot): { date: string; slot: Slot } {
  const i = SLOTS.indexOf(slot);
  if (i < SLOTS.length - 1) return { date, slot: SLOTS[i + 1] };
  return { date: addDays(date, 1), slot: SLOTS[0] };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const SHIPPED_TIMES: Record<Slot, string> = { subh: "07:00", dopahar: "13:00", shaam: "19:30" };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A slot this long past its time without being published is treated as missed (the worker's backfill limit). */
const DUE_GRACE_MIN = 120;

/** The edition times and time zone from settings (edition_times, timezone), with the shipped defaults. */
export async function editionClock(q: Q = db): Promise<{ times: Record<Slot, string>; tz: string }> {
  const rows = await q.select().from(schema.settings).where(inArray(schema.settings.key, ["edition_times", "timezone"]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const raw = (byKey.get("edition_times") ?? {}) as Record<string, unknown>;
  const times = Object.fromEntries(SLOTS.map((s) => [s, typeof raw[s] === "string" && HHMM.test(raw[s] as string) ? raw[s] : SHIPPED_TIMES[s]])) as Record<Slot, string>;
  const tzRaw = byKey.get("timezone");
  let tz = typeof tzRaw === "string" && tzRaw ? tzRaw : TZ;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = TZ; }
  return { times, tz };
}

/** `now` in `tz` as a date (YYYY-MM-DD) and minutes since midnight. */
function localNow(now: Date, tz: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * The edition expected to publish next, by the clock: the slot that fell due less than two hours ago
 * (its run may still be writing it), else the next slot by time; skipping editions that are published or
 * held for review (held ones are chosen explicitly, not by default) and `exclude`. The edition row may not
 * exist yet (`id` null): ensureDraftEdition creates it.
 */
export async function upcomingEdition(q: Q = db, opts: { now?: Date; exclude?: number } = {}): Promise<{ date: string; slot: Slot; id: number | null }> {
  const { times, tz } = await editionClock(q);
  const now = localNow(opts.now ?? new Date(), tz);
  // The latest slot whose time has passed, and how long ago.
  let due: { date: string; slot: Slot } | null = null, ago = 0;
  for (const s of SLOTS) if (toMinutes(times[s]) <= now.minutes) { due = { date: now.date, slot: s }; ago = now.minutes - toMinutes(times[s]); }
  if (!due) { due = { date: addDays(now.date, -1), slot: SLOTS[SLOTS.length - 1] }; ago = now.minutes + 1440 - toMinutes(times[due.slot]); }
  let cand = ago < DUE_GRACE_MIN ? due : followingSlot(due.date, due.slot);
  for (let i = 0; i < 12; i++, cand = followingSlot(cand.date, cand.slot)) {
    const [ed] = await q.select({ id: schema.editions.id, status: schema.editions.status }).from(schema.editions)
      .where(and(eq(schema.editions.date, cand.date), eq(schema.editions.slot, cand.slot)));
    if (!ed) return { ...cand, id: null };
    if (ed.status === "draft" && ed.id !== opts.exclude) return { ...cand, id: ed.id };
  }
  throw new Error("no unpublished edition slot in the next four days");
}

/**
 * The id of the (date, slot) edition, created as an empty draft when missing. Refuses a published edition
 * (immutable). A draft made here is an ordinary draft: the worker's run for that slot writes into it and
 * keeps its manual stories.
 */
export async function ensureDraftEdition(q: Q, date: string, slot: Slot): Promise<{ id: number; status: "draft" | "review" }> {
  const [created] = await q.insert(schema.editions).values({ date, slot, status: "draft" })
    .onConflictDoNothing({ target: [schema.editions.date, schema.editions.slot] }).returning({ id: schema.editions.id });
  if (created) return { id: created.id, status: "draft" };
  const [ed] = await q.select({ id: schema.editions.id, status: schema.editions.status }).from(schema.editions)
    .where(and(eq(schema.editions.date, date), eq(schema.editions.slot, slot)));
  if (!ed) throw new Error(`edition ${date} ${slot} vanished`);
  if (ed.status === "published") throw new Error(`edition ${date} ${slot} is published`);
  return { id: ed.id, status: ed.status };
}

/**
 * Give every group that has stories in the edition an edition_groups row (an edition page lists its
 * stories by those rows), with an empty lead when the worker wrote none. When rows were added, all of the
 * edition's groups are laid out in the configured group order. Returns how many rows were added.
 */
export async function ensureEditionGroups(tx: Tx, editionId: number): Promise<number> {
  const { stories, editionGroups, groups } = schema;
  const missing = await tx.selectDistinct({ groupId: stories.groupId }).from(stories)
    .where(and(eq(stories.editionId, editionId), notExists(tx.select({ one: sql`1` }).from(editionGroups)
      .where(and(eq(editionGroups.editionId, editionId), eq(editionGroups.groupId, stories.groupId))))));
  if (!missing.length) return 0;
  const added = await tx.insert(editionGroups).values(missing.map((m) => ({ editionId, groupId: m.groupId, order: 1000 })))
    .onConflictDoNothing().returning({ id: editionGroups.id });
  if (added.length) {
    const rows = await tx.select({ id: editionGroups.id }).from(editionGroups).innerJoin(groups, eq(groups.id, editionGroups.groupId))
      .where(eq(editionGroups.editionId, editionId)).orderBy(asc(groups.order), asc(groups.id));
    for (const [i, r] of rows.entries()) await tx.update(editionGroups).set({ order: i }).where(eq(editionGroups.id, r.id));
  }
  return added.length;
}

/**
 * SQL: a manual story that is not ready to be seen: it still misses a language, or a fill_language or
 * story_image job for it is queued or running. (A job that failed for good no longer holds it back: a
 * failed image means no image; a failed fill leaves the language missing, which still does.)
 */
export const manualNotReady = sql`(${schema.stories.origin} = 'manual' and (
  ${schema.stories.titleEn} = '' or ${schema.stories.summaryEn} = '' or ${schema.stories.titleUr} = '' or ${schema.stories.summaryUr} = ''
  or exists (select 1 from ${schema.workerJobs} where ${schema.workerJobs.kind} in ('fill_language', 'story_image')
    and ${schema.workerJobs.status} in ('queued', 'running') and ${schema.workerJobs.payload}->>'story_id' = ${schema.stories.id}::text)))`;

/**
 * Put a `desk` story live (desk_at = now) once it is ready and its edition is unpublished. Call after
 * creating or changing a manual story and after each of its jobs ends (lib/jobs.ts does). Takes the
 * story row lock. Returns true when it went live now (then expire the reader cache: EDITIONS_TAG).
 */
export async function goLiveIfReady(tx: Tx, storyId: number): Promise<boolean> {
  const { stories, editions } = schema;
  const [s] = await tx.select({ placement: stories.placement, deskAt: stories.deskAt, status: editions.status })
    .from(stories).innerJoin(editions, eq(editions.id, stories.editionId)).where(eq(stories.id, storyId)).for("update", { of: stories });
  if (!s || s.placement !== "desk" || s.deskAt || s.status === "published") return false;
  const live = await tx.update(stories).set({ deskAt: new Date() })
    .where(and(eq(stories.id, storyId), sql`not ${manualNotReady}`)).returning({ id: stories.id });
  return live.length > 0;
}

/**
 * Called by lib/admin/publish.ts inside the publish transaction, with the edition row locked FOR UPDATE and
 * the decision to publish made, before the stories are counted:
 * 1. manual stories of this edition that are not ready move to the upcoming edition (never published
 *    half-written);
 * 2. live desk stories in other unpublished editions move into this one (they join the next edition that
 *    publishes; an edition another transaction holds locked, a worker PUT say, is skipped and its desk
 *    stories wait for the next publish);
 * 3. every group with stories gets an edition_groups row.
 */
export async function joinDeskStories(tx: Tx, editionId: number): Promise<{ joined: number; deferred: number }> {
  const { stories, editions } = schema;
  let deferred = 0;
  // A live desk story is final whatever its later jobs do (their results are refused), so it is never deferred.
  const pending = await tx.select({ id: stories.id }).from(stories).where(and(eq(stories.editionId, editionId), isNull(stories.deskAt), manualNotReady));
  if (pending.length) {
    const next = await upcomingEdition(tx, { exclude: editionId });
    const target = next.id ?? (await ensureDraftEdition(tx, next.date, next.slot)).id;
    await tx.update(stories).set({ editionId: target }).where(inArray(stories.id, pending.map((p) => p.id)));
    await ensureEditionGroups(tx, target);
    deferred = pending.length;
  }
  const others = tx.select({ id: editions.id }).from(editions)
    .where(and(ne(editions.status, "published"), ne(editions.id, editionId))).for("update", { skipLocked: true });
  const moved = await tx.update(stories).set({ editionId })
    .where(and(isNotNull(stories.deskAt), inArray(stories.editionId, others))).returning({ id: stories.id });
  await ensureEditionGroups(tx, editionId);
  return { joined: moved.length, deferred };
}

/**
 * Whether a story may still be changed: not in a published edition and not live on the desk. Every write
 * to a story's text (the admin, fill_language results) must check this under a lock on the story row.
 */
export function storyIsLive(s: { deskAt: Date | null }, edition: { status: "draft" | "review" | "published" }): boolean {
  return edition.status === "published" || s.deskAt !== null;
}

/**
 * SQL: the story is visible to readers (published edition, or live on the desk) and the editors have not
 * withdrawn it (D14). For queries joined to editions.
 */
export const storyVisibleSql = and(or(eq(schema.editions.status, "published"), isNotNull(schema.stories.deskAt)), isNull(schema.stories.withdrawnAt));
