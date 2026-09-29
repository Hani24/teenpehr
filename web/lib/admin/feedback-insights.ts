import "server-only";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { FEEDBACK_REASONS, REPORT_STATUSES, type FeedbackReason, type ReportStatus } from "@/lib/codes";
import { roleAtLeast, type SessionUser } from "@/lib/auth";
import { topicLabel } from "@/lib/taxonomy";
import { writeAudit } from "./manual";

/*
 * Relevance feedback and mistake reports (decision D8), for the admin: what readers found relevant or
 * wanted less of, by topic, section, outlet, entity and reason over time; each reader's interest profile
 * (owner only); and the editors' queue of "Report a mistake".
 *
 * A vote counts at its last change (story_feedback.updated_at); a removed vote is gone. Days are Karachi
 * days. The data is for insights and a later "For you" ordering that may reweight topics and sections only:
 * it never hides a story from the shared edition and never drops an outlet's perspective, so outlet
 * figures here are for editors to read, not a ranking input.
 */

type Row = Record<string, unknown>;
const rows = async (q: SQL) => (await db.execute(q)) as unknown as Row[];
const KHI = sql`'Asia/Karachi'`;
const n = (v: unknown) => Number(v ?? 0);

export const WINDOWS = [7, 30, 90] as const;
export type Window = (typeof WINDOWS)[number];
export const REASON_LABELS: Record<FeedbackReason, string> = { topic: "Topic", outlet: "Outlet", too_much: "Too much of this", not_for_me: "Not for me" };
export const REASON_LABELS_UR: Record<FeedbackReason, string> = { topic: "موضوع", outlet: "ادارہ", too_much: "اس کی بہت زیادہ خبریں", not_for_me: "میرے لیے نہیں" };

const since = (days: number) => sql`f.updated_at >= now() - make_interval(days => ${days})`;

export type Totals = { up: number; down: number; voters: number; stories: number; withReasons: number; reasons: Record<FeedbackReason, number>; reportsOpen: number; reportsNew: number };

export async function feedbackTotals(days: number): Promise<Totals> {
  const [t] = await rows(sql`select count(*) filter (where f.value = 1)::int as up, count(*) filter (where f.value = -1)::int as down,
      count(distinct f.user_id)::int as voters, count(distinct f.story_id)::int as stories,
      count(*) filter (where f.value = -1 and cardinality(f.reasons) > 0)::int as with_reasons
    from story_feedback f where ${since(days)}`);
  const rs = await rows(sql`select r, count(*)::int as c from story_feedback f cross join lateral unnest(f.reasons) as r where ${since(days)} group by r`);
  const [rep] = await rows(sql`select count(*) filter (where status = 'open')::int as open, count(*) filter (where created_at >= now() - make_interval(days => ${days}))::int as fresh from story_reports`);
  const reasons = Object.fromEntries(FEEDBACK_REASONS.map((r) => [r, 0])) as Record<FeedbackReason, number>;
  for (const r of rs) if ((FEEDBACK_REASONS as readonly string[]).includes(String(r.r))) reasons[r.r as FeedbackReason] = n(r.c);
  return { up: n(t?.up), down: n(t?.down), voters: n(t?.voters), stories: n(t?.stories), withReasons: n(t?.with_reasons), reasons, reportsOpen: n(rep?.open), reportsNew: n(rep?.fresh) };
}

/** One row of a breakdown: votes on stories with this topic/section/outlet/entity, and the "show less" reasons given. */
export type Breakdown = { key: string; label: string; labelUr?: string; extra?: string; up: number; down: number; voters: number; stories: number; reasons: Record<FeedbackReason, number> };

const reasonCols = sql.raw(FEEDBACK_REASONS.map((r) => `count(distinct f.user_id || ':' || f.story_id) filter (where f.value = -1 and '${r}' = any(f.reasons))::int as "r_${r}"`).join(", "));
const reasonsOf = (x: Row) => Object.fromEntries(FEEDBACK_REASONS.map((r) => [r, n(x[`r_${r}`])])) as Record<FeedbackReason, number>;
const votes = sql`count(distinct f.user_id || ':' || f.story_id) filter (where f.value = 1)::int as up,
  count(distinct f.user_id || ':' || f.story_id) filter (where f.value = -1)::int as down,
  count(distinct f.user_id)::int as voters, count(distinct f.story_id)::int as stories`;

export type Dimension = "topic" | "group" | "source" | "entity" | "tag" | "origin";

/** Votes in the last `days` days broken down by one dimension, busiest first (at most `limit` rows). */
export async function feedbackBy(dim: Dimension, days: number, limit = 25): Promise<Breakdown[]> {
  const w = since(days);
  let r: Row[];
  switch (dim) {
    case "topic":
      r = await rows(sql`select t.topic as key, t.topic as label, ${votes}, ${reasonCols}
        from story_feedback f join stories s on s.id = f.story_id cross join lateral unnest(s.topics) as t(topic)
        where ${w} group by t.topic order by count(distinct f.user_id || ':' || f.story_id) desc, t.topic limit ${limit}`);
      return r.map((x) => ({ key: String(x.key), label: topicLabel(String(x.key), "en"), labelUr: topicLabel(String(x.key), "ur"), up: n(x.up), down: n(x.down), voters: n(x.voters), stories: n(x.stories), reasons: reasonsOf(x) }));
    case "group":
      r = await rows(sql`select g.slug as key, g.name_en as label, g.name_ur as label_ur, ${votes}, ${reasonCols}
        from story_feedback f join stories s on s.id = f.story_id join groups g on g.id = s.group_id
        where ${w} group by g.id order by min(g."order"), g.id limit ${limit}`);
      return r.map((x) => ({ key: String(x.key), label: String(x.label), labelUr: String(x.label_ur), up: n(x.up), down: n(x.down), voters: n(x.voters), stories: n(x.stories), reasons: reasonsOf(x) }));
    case "source":
      // Every outlet a story cites shares its votes; "primary" is the story's lead source.
      r = await rows(sql`select src.id::text as key, src.name as label, src.perspective as extra, ${votes}, ${reasonCols}
        from story_feedback f join story_sources ss on ss.story_id = f.story_id join items i on i.id = ss.item_id join sources src on src.id = i.source_id
        where ${w} group by src.id order by count(distinct f.user_id || ':' || f.story_id) desc, src.name limit ${limit}`);
      return r.map((x) => ({ key: String(x.key), label: String(x.label), extra: String(x.extra ?? ""), up: n(x.up), down: n(x.down), voters: n(x.voters), stories: n(x.stories), reasons: reasonsOf(x) }));
    case "entity":
      r = await rows(sql`select en.slug as key, en.name_en as label, en.name_ur as label_ur, en.kind::text as extra, ${votes}, ${reasonCols}
        from story_feedback f join story_entities se on se.story_id = f.story_id join entities en on en.id = se.entity_id
        where ${w} group by en.id order by count(distinct f.user_id || ':' || f.story_id) desc, en.name_en limit ${limit}`);
      return r.map((x) => ({ key: String(x.key), label: String(x.label), labelUr: String(x.label_ur ?? ""), extra: String(x.extra), up: n(x.up), down: n(x.down), voters: n(x.voters), stories: n(x.stories), reasons: reasonsOf(x) }));
    case "tag":
      r = await rows(sql`select s.tag::text as key, s.tag::text as label, ${votes}, ${reasonCols}
        from story_feedback f join stories s on s.id = f.story_id where ${w} group by s.tag order by s.tag`);
      return r.map((x) => ({ key: String(x.key), label: String(x.label), up: n(x.up), down: n(x.down), voters: n(x.voters), stories: n(x.stories), reasons: reasonsOf(x) }));
    case "origin":
      r = await rows(sql`select s.origin::text as key, case s.origin when 'manual' then 'Editors'' manual stories' else 'Written by the worker' end as label, ${votes}, ${reasonCols}
        from story_feedback f join stories s on s.id = f.story_id where ${w} group by s.origin order by s.origin`);
      return r.map((x) => ({ key: String(x.key), label: String(x.label), up: n(x.up), down: n(x.down), voters: n(x.voters), stories: n(x.stories), reasons: reasonsOf(x) }));
  }
}

/** Karachi days (or weeks, over 30 days) with votes and reasons, newest first. */
export async function feedbackOverTime(days: number): Promise<{ unit: "day" | "week"; rows: Array<{ bucket: string; up: number; down: number; reasons: Record<FeedbackReason, number> }> }> {
  const unit = days > 30 ? "week" : "day";
  const bucket = unit === "week" ? sql`date_trunc('week', f.updated_at at time zone ${KHI})::date::text` : sql`(f.updated_at at time zone ${KHI})::date::text`;
  const r = await rows(sql`select ${bucket} as bucket, count(*) filter (where f.value = 1)::int as up, count(*) filter (where f.value = -1)::int as down,
      ${sql.raw(FEEDBACK_REASONS.map((x) => `count(*) filter (where '${x}' = any(f.reasons))::int as "r_${x}"`).join(", "))}
    from story_feedback f where ${since(days)} group by 1 order by 1 desc`);
  return { unit, rows: r.map((x) => ({ bucket: String(x.bucket), up: n(x.up), down: n(x.down), reasons: reasonsOf(x) })) };
}

export type StoryVotes = { id: number; titleEn: string; titleUr: string; group: string; date: string; slot: string; origin: string; up: number; down: number; reasons: Record<FeedbackReason, number> };

/** Stories with the most "relevant" (value 1) or "show less" (value -1) votes in the window. */
export async function topStories(days: number, value: 1 | -1, limit = 10): Promise<StoryVotes[]> {
  const r = await rows(sql`select s.id, s.title_en, s.title_ur, g.name_en as grp, ed.date::text as date, ed.slot::text as slot, s.origin::text as origin,
      count(*) filter (where f.value = 1)::int as up, count(*) filter (where f.value = -1)::int as down,
      ${sql.raw(FEEDBACK_REASONS.map((x) => `count(*) filter (where '${x}' = any(f.reasons))::int as "r_${x}"`).join(", "))}
    from story_feedback f join stories s on s.id = f.story_id join groups g on g.id = s.group_id join editions ed on ed.id = s.edition_id
    where ${since(days)} group by s.id, g.name_en, ed.date, ed.slot
    having count(*) filter (where f.value = ${value}) > 0
    order by count(*) filter (where f.value = ${value}) desc, s.id desc limit ${limit}`);
  return r.map((x) => ({ id: n(x.id), titleEn: String(x.title_en), titleUr: String(x.title_ur), group: String(x.grp), date: String(x.date), slot: String(x.slot), origin: String(x.origin), up: n(x.up), down: n(x.down), reasons: reasonsOf(x) }));
}

// ---- per-reader interest profiles (owner only) ------------------------------------------------

export type ReaderRow = { id: number; name: string; email: string; role: string; status: string; up: number; down: number; reads: number; reports: number; lastVote: Date | null };

export async function readersWithFeedback(): Promise<ReaderRow[]> {
  const r = await rows(sql`select u.id, u.name, u.email, u.role::text as role, u.status::text as status,
      coalesce(fb.up, 0) as up, coalesce(fb.down, 0) as down, fb.last,
      (select count(*)::int from story_reads sr where sr.user_id = u.id) as reads,
      (select count(*)::int from story_reports rp where rp.user_id = u.id) as reports
    from users u left join (select user_id, count(*) filter (where value = 1)::int as up, count(*) filter (where value = -1)::int as down, max(updated_at) as last
      from story_feedback group by user_id) fb on fb.user_id = u.id
    order by fb.last desc nulls last, u.id`);
  return r.map((x) => ({ id: n(x.id), name: String(x.name ?? ""), email: String(x.email), role: String(x.role), status: String(x.status), up: n(x.up), down: n(x.down), reads: n(x.reads), reports: n(x.reports), lastVote: x.last ? new Date(String(x.last)) : null }));
}

/** An affinity row: votes and reads for one topic or section, with the smoothed weight a later "For you" could use. */
export type Affinity = { key: string; label: string; labelUr: string; up: number; down: number; reads: number; weight: number };

/**
 * A reader's interest profile: per topic and section, their votes and reads, and a smoothed weight in -1…1
 * ((up − down) / (up + down + 2)). Preview only: no personal ordering ships yet (D8), and outlets never get a
 * weight (their perspectives are never personalised away).
 */
export async function readerProfile(userId: number) {
  const [user] = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.users.role, status: schema.users.status, createdAt: schema.users.createdAt, lastVisitAt: schema.users.lastVisitAt })
    .from(schema.users).where(eq(schema.users.id, userId));
  if (!user) return null;
  const weight = (up: number, down: number) => (up - down) / (up + down + 2);
  const topicsR = await rows(sql`with v as (select t.topic, count(*) filter (where f.value = 1)::int as up, count(*) filter (where f.value = -1)::int as down
        from story_feedback f join stories s on s.id = f.story_id cross join lateral unnest(s.topics) as t(topic) where f.user_id = ${userId} group by t.topic),
      rd as (select t.topic, count(*)::int as reads from story_reads r join stories s on s.id = r.story_id cross join lateral unnest(s.topics) as t(topic) where r.user_id = ${userId} group by t.topic)
    select coalesce(v.topic, rd.topic) as key, coalesce(v.up, 0) as up, coalesce(v.down, 0) as down, coalesce(rd.reads, 0) as reads
    from v full join rd on rd.topic = v.topic order by coalesce(v.up, 0) + coalesce(v.down, 0) desc, coalesce(rd.reads, 0) desc`);
  const groupsR = await rows(sql`with v as (select s.group_id, count(*) filter (where f.value = 1)::int as up, count(*) filter (where f.value = -1)::int as down
        from story_feedback f join stories s on s.id = f.story_id where f.user_id = ${userId} group by s.group_id),
      rd as (select s.group_id, count(*)::int as reads from story_reads r join stories s on s.id = r.story_id where r.user_id = ${userId} group by s.group_id)
    select g.slug as key, g.name_en as label, g.name_ur as label_ur, coalesce(v.up, 0) as up, coalesce(v.down, 0) as down, coalesce(rd.reads, 0) as reads
    from groups g left join v on v.group_id = g.id left join rd on rd.group_id = g.id
    where v.group_id is not null or rd.group_id is not null order by g."order", g.id`);
  const reasonsR = await rows(sql`select r, count(*)::int as c from story_feedback f cross join lateral unnest(f.reasons) as r where f.user_id = ${userId} group by r`);
  const [tot] = await rows(sql`select count(*) filter (where value = 1)::int as up, count(*) filter (where value = -1)::int as down,
      (select count(*)::int from story_reads where user_id = ${userId}) as reads from story_feedback where user_id = ${userId}`);
  // Outlets on stories this reader wanted less of because of the outlet: shown to the owner, never used to rank.
  const outletsR = await rows(sql`select src.name, src.perspective, count(distinct f.story_id)::int as c
    from story_feedback f join story_sources ss on ss.story_id = f.story_id and ss.is_primary join items i on i.id = ss.item_id join sources src on src.id = i.source_id
    where f.user_id = ${userId} and f.value = -1 and 'outlet' = any(f.reasons) group by src.id order by c desc, src.name limit 20`);
  const recent = await db.select({
    storyId: schema.storyFeedback.storyId, value: schema.storyFeedback.value, reasons: schema.storyFeedback.reasons, updatedAt: schema.storyFeedback.updatedAt,
    titleEn: schema.stories.titleEn, titleUr: schema.stories.titleUr, group: schema.groups.nameEn,
  }).from(schema.storyFeedback).innerJoin(schema.stories, eq(schema.stories.id, schema.storyFeedback.storyId)).innerJoin(schema.groups, eq(schema.groups.id, schema.stories.groupId))
    .where(eq(schema.storyFeedback.userId, userId)).orderBy(desc(schema.storyFeedback.updatedAt)).limit(40);
  const reports = await db.select({ id: schema.storyReports.id, storyId: schema.storyReports.storyId, status: schema.storyReports.status, createdAt: schema.storyReports.createdAt })
    .from(schema.storyReports).where(eq(schema.storyReports.userId, userId)).orderBy(desc(schema.storyReports.createdAt)).limit(20);
  const reasons = Object.fromEntries(FEEDBACK_REASONS.map((r) => [r, 0])) as Record<FeedbackReason, number>;
  for (const r of reasonsR) if ((FEEDBACK_REASONS as readonly string[]).includes(String(r.r))) reasons[r.r as FeedbackReason] = n(r.c);
  return {
    user,
    totals: { up: n(tot?.up), down: n(tot?.down), reads: n(tot?.reads) },
    topics: topicsR.map((x): Affinity => ({ key: String(x.key), label: topicLabel(String(x.key), "en"), labelUr: topicLabel(String(x.key), "ur"), up: n(x.up), down: n(x.down), reads: n(x.reads), weight: weight(n(x.up), n(x.down)) })),
    groups: groupsR.map((x): Affinity => ({ key: String(x.key), label: String(x.label), labelUr: String(x.label_ur), up: n(x.up), down: n(x.down), reads: n(x.reads), weight: weight(n(x.up), n(x.down)) })),
    reasons,
    outlets: outletsR.map((x) => ({ name: String(x.name), perspective: String(x.perspective ?? ""), stories: n(x.c) })),
    recent,
    reports,
  };
}

// ---- the reports queue ("Report a mistake") --------------------------------------------------

export async function reportCounts(): Promise<Record<ReportStatus, number>> {
  const r = await db.select({ status: schema.storyReports.status, c: sql<number>`count(*)::int` }).from(schema.storyReports).groupBy(schema.storyReports.status);
  const out = Object.fromEntries(REPORT_STATUSES.map((s) => [s, 0])) as Record<ReportStatus, number>;
  for (const x of r) out[x.status] = Number(x.c);
  return out;
}

export async function listReports(status: ReportStatus, limit = 100) {
  // The name only: the email address is for owners (the page decides), never a fallback shown to editors.
  const reporter = sql<string | null>`(select nullif(u.name, '') from users u where u.id = ${schema.storyReports.userId})`;
  const reporterEmail = sql<string | null>`(select u.email from users u where u.id = ${schema.storyReports.userId})`;
  const resolver = sql<string | null>`(select coalesce(nullif(u.name, ''), u.email) from users u where u.id = ${schema.storyReports.resolvedBy})`;
  const others = sql<number>`(select count(*)::int from story_reports o where o.story_id = ${schema.storyReports.storyId} and o.id <> ${schema.storyReports.id})`;
  return db.select({
    id: schema.storyReports.id, text: schema.storyReports.text, locale: schema.storyReports.locale, status: schema.storyReports.status, note: schema.storyReports.note,
    createdAt: schema.storyReports.createdAt, resolvedAt: schema.storyReports.resolvedAt, reporterId: schema.storyReports.userId, reporter, reporterEmail, resolver, others,
    storyId: schema.stories.id, titleEn: schema.stories.titleEn, titleUr: schema.stories.titleUr, origin: schema.stories.origin, deskAt: schema.stories.deskAt,
    editionId: schema.editions.id, editionDate: schema.editions.date, editionSlot: schema.editions.slot, editionStatus: schema.editions.status, group: schema.groups.nameEn,
  }).from(schema.storyReports)
    .innerJoin(schema.stories, eq(schema.stories.id, schema.storyReports.storyId))
    .innerJoin(schema.editions, eq(schema.editions.id, schema.stories.editionId))
    .innerJoin(schema.groups, eq(schema.groups.id, schema.stories.groupId))
    .where(eq(schema.storyReports.status, status))
    .orderBy(status === "open" ? schema.storyReports.createdAt : desc(schema.storyReports.updatedAt), desc(schema.storyReports.id)).limit(limit);
}

/** Resolve or dismiss a report (with the editor's note), or reopen it. Logged. */
export async function decideReport(user: SessionUser, id: number, status: ReportStatus, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!roleAtLeast(user.role, "editor")) return { ok: false, error: "Editors and owners only." };
  const now = new Date();
  const decided = status === "open" ? { resolvedBy: null, resolvedAt: null } : { resolvedBy: user.id, resolvedAt: now };
  return db.transaction(async (tx) => {
    const [prev] = await tx.select({ status: schema.storyReports.status, storyId: schema.storyReports.storyId }).from(schema.storyReports).where(eq(schema.storyReports.id, id)).for("update");
    if (!prev) return { ok: false as const, error: "That report no longer exists." };
    if (prev.status === status) return { ok: false as const, error: `Report ${id} is already ${status}.` };
    await tx.update(schema.storyReports).set({ status, note: note.slice(0, 2000), ...decided, updatedAt: now }).where(and(eq(schema.storyReports.id, id)));
    await writeAudit(tx, user.id, `report.${status === "open" ? "reopen" : status === "resolved" ? "resolve" : "dismiss"}`, `report:${id}`, { story_id: prev.storyId, from: prev.status, note: note.slice(0, 300) });
    return { ok: true as const };
  });
}
