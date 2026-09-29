import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin/session";
import { roleAtLeast } from "@/lib/auth";
import { JOB_KINDS, JOB_STATUSES, type JobKind, type JobStatus } from "@/lib/codes";
import { cancelJobAction, retryJobAction } from "@/lib/admin/manual-actions";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { Button } from "@/components/admin/form";
import { ChipNav, JobPill, personLabel } from "../stories/_ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Worker jobs" };

const { workerJobs: j, users } = schema;
/** A payload's integer id, or null (never a cast error on an odd payload). */
const payloadInt = (payload: typeof j.payload, key: "story_id" | "item_id") => {
  const k = sql.raw(`'${key}'`); // one of two fixed names, never input
  return sql`(case when ${payload}->>${k} ~ '^[0-9]{1,9}$' then (${payload}->>${k})::int end)`;
};
const KIND_LABEL: Record<JobKind, string> = { translate_article: "Full translation", fill_language: "Write missing language", story_image: "Article image" };

/**
 * Work the site queued for the worker between editions (docs/API.md § Jobs): D9 translations and D12
 * manual-story fills and images. Failed jobs can be retried (fresh attempts); queued ones cancelled. A
 * blocked job is final (paywall, robots.txt, …) except a translation blocked for a transient reason,
 * retried from Translations.
 */
export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin("/admin/jobs");
  const owner = roleAtLeast(user.role, "owner");
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const kind = (JOB_KINDS as readonly string[]).includes(one("kind")) ? (one("kind") as JobKind) : null;
  const status = (JOB_STATUSES as readonly string[]).includes(one("status")) ? (one("status") as JobStatus) : null;
  const onlyId = /^\d{1,9}$/.test(one("id")) ? Number(one("id")) : null;
  const [rows, counts, flash] = await Promise.all([
    db.select({
      job: j, requester: { id: users.id, name: users.name, email: users.email },
      // Integer comparisons, so each lookup uses the primary key (payload ids are validated integers at enqueue).
      storyTitle: sql<string | null>`(select coalesce(nullif(s.title_en, ''), s.title_ur) from stories s where s.id = ${payloadInt(j.payload, "story_id")})`,
      itemTitle: sql<string | null>`(select i.title from items i where i.id = ${payloadInt(j.payload, "item_id")})`,
      translationId: sql<number | null>`(select t.id from article_translations t where t.job_id = ${j.id} limit 1)`,
      leaseMin: sql<number | null>`case when ${j.status} = 'running' and ${j.lockedUntil} is not null then round(extract(epoch from ${j.lockedUntil} - now()) / 60)::int end`,
      waiting: sql<boolean>`${j.status} = 'queued' and ${j.runAfter} > now()`,
    }).from(j).leftJoin(users, eq(users.id, j.requestedBy))
      .where(onlyId ? eq(j.id, onlyId) : and(kind ? eq(j.kind, kind) : undefined, status ? eq(j.status, status) : undefined))
      .orderBy(desc(j.id)).limit(200),
    db.select({ status: j.status, n: sql<number>`count(*)::int` }).from(j).where(kind ? eq(j.kind, kind) : undefined).groupBy(j.status),
    flashFrom(searchParams),
  ]);
  const href = (p: { kind?: JobKind | null; status?: JobStatus | null }) => {
    const q = new URLSearchParams();
    const k = p.kind === undefined ? kind : p.kind, st = p.status === undefined ? status : p.status;
    if (k) q.set("kind", k);
    if (st) q.set("status", st);
    const s = q.toString();
    return `/admin/jobs${s ? `?${s}` : ""}`;
  };
  const total = counts.reduce((a, c) => a + c.n, 0);
  const back = onlyId ? `/admin/jobs?id=${onlyId}` : href({});
  return (
    <AdminShell title="Worker jobs" flash={flash}>
      <p className="meta mb-3 max-w-3xl">The worker claims these between editions. A running job holds a lease; when the lease runs out without a report it is claimed again (each claim is one attempt).</p>
      {onlyId ? <p className="mb-3"><Link href="/admin/jobs" className="chip">Show all jobs</Link></p> : (
        <>
          <ChipNav label="Kind" items={[{ href: href({ kind: null }), label: "All kinds", current: !kind }, ...JOB_KINDS.map((k) => ({ href: href({ kind: k }), label: KIND_LABEL[k], current: kind === k }))]} />
          <ChipNav label="Status" items={[{ href: href({ status: null }), label: "Any status", current: !status, count: total }, ...JOB_STATUSES.map((st) => ({ href: href({ status: st }), label: st, current: status === st, count: counts.find((c) => c.status === st)?.n ?? 0 }))]} />
        </>
      )}
      {rows.length === 0 ? <Empty>{onlyId ? `No job #${onlyId}.` : total === 0 ? "No jobs yet. Translations readers ask for and manual stories' fills and images appear here." : "No jobs match."}</Empty> : (
        <Table caption="Worker jobs">
          <thead><tr><Th>Job</Th><Th>For</Th><Th>Status</Th><Th>Attempts</Th><Th>Timing</Th><Th>Error or result</Th></tr></thead>
          <tbody>
            {rows.map(({ job, requester, storyTitle, itemTitle, translationId, leaseMin: leaseLeft, waiting }) => {
              const p = job.payload as { story_id?: number; item_id?: number; lang?: string };
              const asker = requester ? personLabel(requester, owner) : null;
              return (
                <tr key={job.id} className={onlyId ? "bg-surface-2" : undefined}>
                  <Td>#{job.id}<span className="meta block">{KIND_LABEL[job.kind]}{job.kind === "fill_language" && p.lang ? ` (${p.lang === "en" ? "English" : "Urdu"})` : ""}</span><span className="meta block">priority {job.priority}</span></Td>
                  <Td className="max-w-xs">
                    {p.story_id ? <Link href={`/admin/stories/${p.story_id}`}>story #{p.story_id}</Link> : null}
                    {job.kind === "translate_article" && translationId ? <Link href={`/admin/translations/${translationId}`}>translation #{translationId}</Link> : null}
                    <span className="meta block truncate" dir="auto">{storyTitle ?? itemTitle ?? (p.item_id ? `item #${p.item_id}` : "")}</span>
                    {asker && <span className="meta block">asked by <bdi>{asker}</bdi></span>}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <JobPill status={job.status} />{leaseLeft != null && <span className="meta block">{job.lockedBy} · lease {leaseLeft >= 0 ? `${leaseLeft} min left` : "expired"}</span>}
                    {/* The action sits with the status it acts on, so it never scrolls out of a wide table. */}
                    {job.status === "failed" && <form action={retryJobAction} className="mt-1"><input type="hidden" name="id" value={job.id} /><input type="hidden" name="back" value={back} /><Button>Retry</Button></form>}
                    {job.status === "queued" && <form action={cancelJobAction} className="mt-1"><input type="hidden" name="id" value={job.id} /><input type="hidden" name="back" value={back} /><Button>Cancel</Button></form>}
                  </Td>
                  <Td className="tabular-nums">{job.attempts}/{job.maxAttempts}</Td>
                  <Td className="whitespace-nowrap text-xs">
                    queued {fmtDate(job.createdAt)}
                    {waiting && <span className="block">retry after {fmtDate(job.runAfter)}</span>}
                    {job.startedAt && <span className="block">started {fmtDate(job.startedAt)}</span>}
                    {job.finishedAt && <span className="block">ended {fmtDate(job.finishedAt)}</span>}
                  </Td>
                  <Td className="min-w-40 max-w-sm break-words text-sm text-ink-2">{job.error ?? (job.result ? summary(job.result) : "")}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </AdminShell>
  );
}

/** A job's stored result in one short line (usage, a note, the image id). */
function summary(r: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof r.note === "string" && r.note) parts.push(r.note);
  if (r.blocked && typeof r.blocked === "object") parts.push(`blocked: ${String((r.blocked as { reason?: unknown }).reason ?? "")}`);
  if (typeof r.image_id === "number") parts.push(`image #${r.image_id}`);
  if (typeof r.source_words === "number") parts.push(`${r.source_words} words`);
  if (r.check_ok === false) parts.push("check failed");
  if (typeof r.model === "string" && r.model) parts.push(r.model);
  if (typeof r.cost_usd === "number" && r.cost_usd) parts.push(`$${r.cost_usd.toFixed(4)}`);
  return parts.join(" · ");
}
