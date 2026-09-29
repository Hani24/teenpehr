import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin/session";
import { roleAtLeast } from "@/lib/auth";
import { TRANSLATION_STATUSES, type TranslationStatus } from "@/lib/codes";
import { RETRYABLE_BLOCKS } from "@/lib/admin/manual";
import { retryTranslationAction } from "@/lib/admin/manual-actions";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { Button } from "@/components/admin/form";
import { ChipNav, JobPill, personLabel, Stat } from "../stories/_ui";
import { BLOCK_TEXT } from "./_labels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Translations" };

const { articleTranslations: t, items, sources, users, workerJobs } = schema;
const nf = new Intl.NumberFormat("en-GB");
const usd = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;

/**
 * Full-article Urdu translations readers asked for (D9): status, the faithfulness check, cost, and a retry for
 * failed ones (and blocked ones only when the block was transient: the site was down or needed the Germany
 * route; a paywall or robots.txt is final and never tried harder).
 */
export default async function TranslationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin("/admin/translations");
  const owner = roleAtLeast(user.role, "owner");
  const sp = await searchParams;
  const s = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = (TRANSLATION_STATUSES as readonly string[]).includes(s ?? "") ? (s as TranslationStatus) : null;
  const since = (h: number) => sql`now() - make_interval(hours => ${h})`;
  const [rows, counts, [cost], requesters, flash] = await Promise.all([
    db.select({
      id: t.id, itemId: t.itemId, status: t.status, title: t.title, sourceWords: t.sourceWords, model: t.model, costUsd: t.costUsd, tokensIn: t.tokensIn, tokensOut: t.tokensOut,
      checkOk: t.checkOk, checkNote: t.checkNote, error: t.error, blockedReason: t.blockedReason, requestedAt: t.requestedAt, finishedAt: t.finishedAt, jobId: t.jobId,
      bodyChars: sql<number | null>`char_length(${t.body})`,
      itemTitle: items.title, itemUrl: items.url, itemLang: items.lang, source: sources.name, requester: { id: users.id, name: users.name, email: users.email },
      jobStatus: workerJobs.status, attempts: workerJobs.attempts, maxAttempts: workerJobs.maxAttempts,
      storyId: sql<number | null>`(select max(ss.story_id) from story_sources ss where ss.item_id = ${t.itemId})`,
    }).from(t).innerJoin(items, eq(items.id, t.itemId)).innerJoin(sources, eq(sources.id, items.sourceId))
      .leftJoin(users, eq(users.id, t.requestedBy)).leftJoin(workerJobs, eq(workerJobs.id, t.jobId))
      .where(status ? eq(t.status, status) : undefined).orderBy(desc(t.requestedAt), desc(t.id)).limit(150),
    db.select({ status: t.status, n: sql<number>`count(*)::int` }).from(t).groupBy(t.status),
    db.select({
      day: sql<number>`coalesce(sum(${t.costUsd}) filter (where ${t.finishedAt} >= ${since(24)}), 0)::float8`,
      week: sql<number>`coalesce(sum(${t.costUsd}) filter (where ${t.finishedAt} >= ${since(24 * 7)}), 0)::float8`,
      month: sql<number>`coalesce(sum(${t.costUsd}) filter (where ${t.finishedAt} >= ${since(24 * 30)}), 0)::float8`,
      words: sql<number>`coalesce(sum(${t.sourceWords}) filter (where ${t.status} = 'done'), 0)::int`,
      failedChecks: sql<number>`count(*) filter (where ${t.status} = 'done' and ${t.checkOk} = false)::int`,
    }).from(t),
    db.select({ id: users.id, name: users.name, email: users.email, n: sql<number>`count(*)::int` }).from(workerJobs).innerJoin(users, eq(users.id, workerJobs.requestedBy))
      .where(and(eq(workerJobs.kind, "translate_article"), sql`${workerJobs.createdAt} >= ${since(24)}`)).groupBy(users.id).orderBy(desc(sql`count(*)`)).limit(10),
    flashFrom(searchParams),
  ]);
  const count = (st: TranslationStatus) => counts.find((c) => c.status === st)?.n ?? 0;
  const total = counts.reduce((a, c) => a + c.n, 0);
  const back = `/admin/translations${status ? `?status=${status}` : ""}`;
  return (
    <AdminShell title="Translations" flash={flash} actions={<Link href="/admin/jobs?kind=translate_article" className="chip">Translation jobs</Link>}>
      <p className="meta mb-3 max-w-3xl">
        Full Urdu translations of cited articles, made when a reader asks and kept for everyone after. Readers see them only inside Tabayyun, labelled as an AI
        translation with the original link; never in feeds, downloads, search or the X board. A failed faithfulness check (numbers, names, quotes, nothing added
        or dropped) is shown to readers as a warning; read those first.
      </p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Usage, last 24 hours" value={usd(Number(cost?.day ?? 0))} sub="API-equivalent; counts toward the worker's daily budget" />
        <Stat label="Last 7 days" value={usd(Number(cost?.week ?? 0))} />
        <Stat label="Last 30 days" value={usd(Number(cost?.month ?? 0))} />
        <Stat label="Words translated" value={nf.format(Number(cost?.words ?? 0))} />
        <Stat label="Failed faithfulness checks" value={nf.format(Number(cost?.failedChecks ?? 0))} tone={Number(cost?.failedChecks ?? 0) ? "bad" : undefined} />
      </div>
      {requesters.length > 0 && (
        <p className="meta mb-3">Requests in the last 24 hours: {requesters.map((r) => `${personLabel(r, owner)} ${r.n}`).join(" · ")}</p>
      )}
      <ChipNav label="Status" items={[
        { href: "/admin/translations", label: "All", current: !status, count: total },
        ...TRANSLATION_STATUSES.map((st) => ({ href: `/admin/translations?status=${st}`, label: st, current: status === st, count: count(st) })),
      ]} />
      {rows.length === 0 ? (
        <Empty>{total === 0 ? "No reader has asked for a full translation yet. The button is on each story's source list, for articles not in Urdu." : "None with this status."}</Empty>
      ) : (
        <Table caption="Translations">
          <thead><tr><Th>Article</Th><Th>Status</Th><Th>Check</Th><Th className="text-end">Words</Th><Th className="text-end">Cost</Th><Th>Asked</Th><Th></Th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const retryable = r.status === "failed" || (r.status === "blocked" && !!r.blockedReason && (RETRYABLE_BLOCKS as readonly string[]).includes(r.blockedReason));
              return (
                <tr key={r.id}>
                  <Td className="max-w-md">
                    <Link href={`/admin/translations/${r.id}`} className="font-semibold"><bdi>{r.itemTitle}</bdi></Link>
                    <span className="meta block">{r.source} · {r.itemLang} · <a href={r.itemUrl} target="_blank" rel="noreferrer">original ↗</a>{r.storyId ? <> · cited by story <a href={`/en/story/${r.storyId}`} target="_blank" rel="noreferrer">#{r.storyId}</a></> : null}</span>
                  </Td>
                  <Td>
                    <JobPill status={r.status} />
                    {r.blockedReason && <span className="meta block">{BLOCK_TEXT[r.blockedReason] ?? r.blockedReason}</span>}
                    {r.status !== "done" && r.error && <span className="meta block max-w-xs break-words" title={r.error}>{r.error.slice(0, 120)}</span>}
                    {r.jobId && <span className="meta block">job <Link href={`/admin/jobs?id=${r.jobId}`}>#{r.jobId}</Link>{r.attempts != null ? ` · ${r.attempts}/${r.maxAttempts}` : ""}</span>}
                  </Td>
                  <Td>{r.status !== "done" ? <span className="meta">—</span> : r.checkOk === false ? <span className="pill pill-accent" title={r.checkNote ?? ""}>failed</span> : r.checkOk ? <span className="pill pill-soft text-ok">passed</span> : <span className="meta">not run</span>}
                    {r.checkNote && <span className="meta block max-w-xs break-words">{r.checkNote.slice(0, 140)}</span>}</Td>
                  <Td className="text-end tabular-nums">{r.sourceWords != null ? nf.format(r.sourceWords) : "—"}</Td>
                  <Td className="text-end tabular-nums">{Number(r.costUsd) ? usd(Number(r.costUsd)) : "—"}<span className="meta block">{r.model ?? ""}</span></Td>
                  <Td className="whitespace-nowrap">{fmtDate(r.requestedAt)}<span className="meta block"><bdi>{personLabel(r.requester ?? { id: null, name: null, email: null }, owner) ?? "—"}</bdi></span>{r.finishedAt && (r.status === "done" || r.status === "failed" || r.status === "blocked") && <span className="meta block">{r.status === "done" ? "done" : "ended"} {fmtDate(r.finishedAt)}</span>}</Td>
                  <Td>{retryable && <form action={retryTranslationAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={back} /><Button>Retry</Button></form>}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </AdminShell>
  );
}
