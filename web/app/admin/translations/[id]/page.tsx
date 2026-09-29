import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin/session";
import { roleAtLeast } from "@/lib/auth";
import { RETRYABLE_BLOCKS, auditFor } from "@/lib/admin/manual";
import { retryTranslationAction } from "@/lib/admin/manual-actions";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Button } from "@/components/admin/form";
import { JobPill, personLabel } from "../../stories/_ui";
import { BLOCK_TEXT } from "../_labels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Translation" };

const { articleTranslations: t, items, sources, users, workerJobs } = schema;

/** One translation (D9): the Urdu text as readers get it, with the check, cost and job, for an editor to review. */
export default async function TranslationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin("/admin/translations");
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) notFound();
  const [[r], flash] = await Promise.all([
    db.select({
      tr: t, itemTitle: items.title, itemUrl: items.url, itemLang: items.lang, publishedAt: items.publishedAt, source: sources.name, perspective: sources.perspective,
      requester: { id: users.id, name: users.name, email: users.email }, job: workerJobs,
      stories: sql<number[]>`coalesce((select array_agg(ss.story_id order by ss.story_id desc) from story_sources ss where ss.item_id = ${t.itemId}), '{}')`,
    }).from(t).innerJoin(items, eq(items.id, t.itemId)).innerJoin(sources, eq(sources.id, items.sourceId))
      .leftJoin(users, eq(users.id, t.requestedBy)).leftJoin(workerJobs, eq(workerJobs.id, t.jobId)).where(eq(t.id, id)),
    flashFrom(searchParams),
  ]);
  if (!r) notFound();
  const tr = r.tr;
  const history = await auditFor([`translation:${id}`, ...(tr.jobId ? [`job:${tr.jobId}`] : [])]);
  const retryable = tr.status === "failed" || (tr.status === "blocked" && !!tr.blockedReason && (RETRYABLE_BLOCKS as readonly string[]).includes(tr.blockedReason));
  const paragraphs = (tr.body ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <AdminShell title={`Translation #${tr.id}`} flash={flash} actions={<Link href="/admin/translations" className="chip">All translations</Link>}>
      <section className="card mb-6 grid gap-2 p-4 text-sm">
        <p><JobPill status={tr.status} /> {tr.blockedReason && <span>· {BLOCK_TEXT[tr.blockedReason] ?? tr.blockedReason}</span>}</p>
        <p>Original: <a href={r.itemUrl} target="_blank" rel="noreferrer"><bdi>{r.itemTitle}</bdi></a> <span className="meta">({r.source}{r.perspective ? ` · ${r.perspective}` : ""} · {r.itemLang} · published {fmtDate(r.publishedAt)})</span></p>
        <p>Cited by {r.stories.length ? r.stories.map((sid, i) => <span key={sid}>{i ? ", " : ""}<a href={`/en/story/${sid}`} target="_blank" rel="noreferrer">story #{sid}</a></span>) : "no story"}.</p>
        <p>First asked {fmtDate(tr.requestedAt)} by <bdi>{personLabel(r.requester ?? { id: null, name: null, email: null }, roleAtLeast(user.role, "owner")) ?? "—"}</bdi>{tr.finishedAt && (tr.status === "done" || tr.status === "failed" || tr.status === "blocked") && <> · {tr.status === "done" ? "finished" : "ended"} {fmtDate(tr.finishedAt)}</>}</p>
        <p>{tr.sourceWords != null && <>{tr.sourceWords} words in the original · </>}{tr.model ?? "no model"} · {tr.tokensIn} in / {tr.tokensOut} out tokens · ${Number(tr.costUsd).toFixed(4)} (API-equivalent)</p>
        {tr.status === "done" && (
          <p>Faithfulness check: {tr.checkOk === false ? <strong className="text-accent">failed</strong> : tr.checkOk ? <strong className="text-ok">passed</strong> : "not run"}{tr.checkNote && <> · {tr.checkNote}</>}</p>
        )}
        {tr.error && <p className="text-ink-2">Note: {tr.error}</p>}
        {r.job && <p className="meta">Job <Link href={`/admin/jobs?id=${r.job.id}`}>#{r.job.id}</Link> · {r.job.status} · attempts {r.job.attempts}/{r.job.maxAttempts}{r.job.lockedBy ? ` · held by ${r.job.lockedBy}` : ""}</p>}
        {retryable && <form action={retryTranslationAction}><input type="hidden" name="id" value={tr.id} /><input type="hidden" name="back" value={`/admin/translations/${tr.id}`} /><Button>Retry</Button></form>}
      </section>
      {tr.status === "done" && tr.body ? (
        <article className="card mb-6 p-6" lang="ur" dir="rtl">
          <p className="meta mb-3" lang="en" dir="ltr">As readers see it, under &ldquo;AI translation of {r.source}&apos;s article · may contain errors&rdquo;:</p>
          {tr.title && <h2 className="mb-4 text-2xl font-semibold leading-[2]">{tr.title}</h2>}
          <div className="grid max-w-[46rem] gap-4 text-lg leading-[2.2]">{paragraphs.map((p, i) => <p key={i}>{p}</p>)}</div>
        </article>
      ) : (
        <p className="card mb-6 p-6 text-center text-ink-2">{tr.status === "blocked" ? "No text: readers get \"could not get the full text, here is the link\"." : "No text yet."}</p>
      )}
      {history.length > 0 && (
        <section aria-labelledby="hist">
          <h2 id="hist" className="mb-2 font-semibold">History</h2>
          <ul className="card divide-y divide-rule text-sm">{history.map((a) => <li key={a.id} className="px-3 py-2"><span className="meta">{fmtDate(a.at)}</span> · {a.userName || a.userEmail || "—"} · {a.action}</li>)}</ul>
        </section>
      )}
    </AdminShell>
  );
}
