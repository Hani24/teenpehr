import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin/session";
import { auditFor, getManualStory, notReadyReasons } from "@/lib/admin/manual";
import { goLiveAction, removeManualStoryAction, retryJobAction, cancelJobAction, updateManualStoryAction } from "@/lib/admin/manual-actions";
import { fmtDate } from "@/lib/admin/util";
import { roleAtLeast } from "@/lib/auth";
import { mediaUrl, sortedVariants } from "@/lib/media";
import { TOPICS, TOPIC_LABELS } from "@/lib/taxonomy";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { Button } from "@/components/admin/form";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { ChoiceGroup, JobPill, ManualTag, StatePill } from "../_ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Manual story" };

const field = "w-full rounded border border-rule bg-surface px-2 py-2 text-ink focus:border-focus";

export default async function ManualStoryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin("/admin/stories");
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) notFound();
  const [s, flash] = await Promise.all([getManualStory(id), flashFrom(searchParams)]);
  if (!s) notFound();
  const [history, groups] = await Promise.all([
    auditFor([`story:${id}`, ...s.jobs.map((j) => `job:${j.id}`)]),
    db.select({ id: schema.groups.id, nameEn: schema.groups.nameEn, nameUr: schema.groups.nameUr, active: schema.groups.active }).from(schema.groups).orderBy(schema.groups.order, schema.groups.id),
  ]);
  const primary = s.sources.find((x) => x.isPrimary) ?? s.sources[0];
  const unchecked = primary?.item.fetch?.via === "admin-manual-unchecked";
  const canRemove = !s.live && (s.createdBy === user.id || roleAtLeast(user.role, "owner"));
  const reasons = notReadyReasons(s, s.jobs);
  const img = s.image && !s.imageHiddenAt ? sortedVariants(s.image)[0] : null;
  const readerHref = s.live ? `/en/story/${s.id}` : null;
  const back = `/admin/stories/${s.id}`;
  return (
    <AdminShell title={s.titleEn || s.titleUr || `Story ${s.id}`} flash={flash} actions={<>
      <Link href="/admin/stories" className="chip">All manual stories</Link>
      {readerHref && <a href={readerHref} target="_blank" rel="noreferrer" className="chip">View as a reader ↗</a>}
    </>}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatePill state={s.state} />
        <ManualTag name={s.createdByName || "Editor"} />
      </div>

      <section aria-labelledby="where" className="card mb-6 grid gap-2 p-4 text-sm">
        <h2 id="where" className="font-semibold">Where it is</h2>
        <p>
          {s.placement === "desk" ? "Editor's desk" : "In an edition"} · edition <Link href={`/admin/editions/${s.edition.id}#story-${s.id}`}>{s.edition.date} {s.edition.slot}</Link> ({s.edition.status})
          {s.deskAt && <> · live since {fmtDate(s.deskAt)}</>} · section {s.group.nameEn} · tag {s.tag} · coverage {s.coverage ?? "—"}
        </p>
        <p>Added {fmtDate(s.createdAt)} by {s.creator ? (s.creator.name || s.creator.email) : "an account since removed"} (byline &ldquo;{s.createdByName}&rdquo;).</p>
        {primary && (
          <p>
            Cited link: <a href={primary.item.url} target="_blank" rel="noreferrer" className="break-all">{primary.item.url}</a>
            <span className="meta block">{primary.item.source.name} ({primary.item.source.kind}{primary.item.source.perspective ? ` · ${primary.item.source.perspective}` : ""}) · item #{primary.item.id}
              {unchecked && <strong className="text-warn"> · added without a successful link check</strong>}</span>
          </p>
        )}
        {s.state === "waiting" && (
          <div className="mt-1 rounded border border-warn p-3">
            {reasons.length ? <p><strong>Not ready:</strong> {reasons.join("; ")}.</p> : <p><strong>Ready.</strong> {s.placement === "desk" ? "It should go live on its own; if it has not, put it live now." : ""}</p>}
            {s.placement === "desk" && !reasons.length && (
              <form action={goLiveAction} className="mt-2"><input type="hidden" name="id" value={s.id} /><Button tone="primary">Put it live on the desk</Button></form>
            )}
          </div>
        )}
        {s.live && <p className="meta">Live stories are immutable. Add a correction from <Link href={`/admin/editions/${s.edition.id}#story-${s.id}`}>the edition page</Link>.</p>}
      </section>

      <section aria-labelledby="jobs" className="mb-6">
        <h2 id="jobs" className="mb-2 font-semibold">Worker jobs</h2>
        {s.jobs.length === 0 ? <Empty>None: the editor wrote both languages and chose no article image.</Empty> : (
          <Table caption="Worker jobs for this story">
            <thead><tr><Th>Job</Th><Th>Status</Th><Th>Attempts</Th><Th>Last change</Th><Th>Error</Th><Th></Th></tr></thead>
            <tbody>
              {s.jobs.map((j) => (
                <tr key={j.id}>
                  <Td><Link href={`/admin/jobs?id=${j.id}`}>#{j.id}</Link> {j.kind === "story_image" ? "article image" : `write ${j.lang === "en" ? "English" : "Urdu"}`}</Td>
                  <Td><JobPill status={j.status} /></Td>
                  <Td className="tabular-nums">{j.attempts}/{j.maxAttempts}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(j.updatedAt)}</Td>
                  <Td className="max-w-sm break-words text-ink-2">{j.error ?? ""}</Td>
                  <Td>
                    {j.status === "failed" && !s.live && <form action={retryJobAction}><input type="hidden" name="id" value={j.id} /><input type="hidden" name="back" value={back} /><Button>Retry</Button></form>}
                    {j.status === "queued" && <form action={cancelJobAction}><input type="hidden" name="id" value={j.id} /><input type="hidden" name="back" value={back} /><Button>Cancel</Button></form>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {s.image && (
        <section aria-labelledby="img" className="card mb-6 flex flex-wrap items-start gap-3 p-4 text-sm">
          <h2 id="img" className="sr-only">Image</h2>
          {img && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaUrl(img.file)} alt={s.image.alt ?? `Image from ${s.image.credit}`} width={img.w} height={img.h} className="block rounded object-cover"
              style={{ background: s.image.color, blockSize: "6rem", inlineSize: "auto", maxInlineSize: "10rem" }} />
          )}
          <p>Image · credit <strong>{s.image.credit}</strong> · {s.image.width}×{s.image.height}{s.image.graphic && <span className="pill pill-soft ms-1 text-accent">sensitive</span>}
            {s.imageHiddenAt && <span className="pill pill-soft ms-1 text-warn">hidden from readers</span>}
            <span className="meta block">Alt: {s.image.alt ?? `none (readers get "Image from ${s.image.credit}")`}. Hide it from the edition page if needed.</span></p>
        </section>
      )}

      {s.live ? (
        <section aria-labelledby="text" className="card mb-6 grid gap-4 p-4 md:grid-cols-2">
          <h2 id="text" className="sr-only">Text</h2>
          <div>
            <h3 className="font-semibold">{s.titleEn}</h3><p className="mt-1 text-sm">{s.summaryEn}</p>
            {s.whyEn && <p className="meta mt-1">Why: {s.whyEn}</p>}{s.contestedEn && <p className="meta mt-1">Contested: {s.contestedEn}</p>}
            {s.languageFilled === "en" && <p className="meta mt-2">English written by the worker from the editor&apos;s Urdu.</p>}
          </div>
          <div lang="ur" dir="rtl">
            <h3 className="font-semibold leading-[2]">{s.titleUr}</h3><p className="mt-1 text-sm leading-[2.2]">{s.summaryUr}</p>
            {s.whyUr && <p className="meta mt-1">{s.whyUr}</p>}{s.contestedUr && <p className="meta mt-1">{s.contestedUr}</p>}
            {s.languageFilled === "ur" && <p className="meta mt-2" lang="en" dir="ltr">Urdu written by the worker from the editor&apos;s English.</p>}
          </div>
          {s.corrections.length > 0 && (
            <ul className="text-sm md:col-span-2">{s.corrections.map((c) => <li key={c.id}><span className="meta">{fmtDate(c.createdAt)}</span> · {c.textEn}</li>)}</ul>
          )}
        </section>
      ) : (
        <form action={updateManualStoryAction} className="card mb-6 grid gap-4 p-4">
          <h2 className="font-semibold">Edit</h2>
          <input type="hidden" name="id" value={s.id} />
          <p className="meta">Empty a whole language to have the worker write it again from the other; write it yourself to cancel a queued fill.</p>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid content-start gap-3">
              <h3 className="font-semibold">English {s.languageFilled === "en" && <span className="pill pill-soft">filled by the worker</span>}</h3>
              <Text label="Title" name="title_en" value={s.titleEn} max={300} />
              <Text label="Summary" name="summary_en" value={s.summaryEn} max={3000} rows={5} />
              <Text label="Why it matters" name="why_en" value={s.whyEn} max={1000} rows={2} />
              <Text label="What is contested" name="contested_en" value={s.contestedEn} max={1000} rows={2} />
            </div>
            <div className="grid content-start gap-3" lang="ur" dir="rtl">
              <h3 className="font-semibold">اردو {s.languageFilled === "ur" && <span className="pill pill-soft" lang="en" dir="ltr">filled by the worker</span>}</h3>
              <Text label="سرخی" name="title_ur" value={s.titleUr} max={300} ur />
              <Text label="خلاصہ" name="summary_ur" value={s.summaryUr} max={3000} rows={5} ur />
              <Text label="یہ کیوں اہم ہے" name="why_ur" value={s.whyUr} max={1000} rows={2} ur />
              <Text label="کیا متنازع ہے" name="contested_ur" value={s.contestedUr} max={1000} rows={2} ur />
            </div>
          </div>
          {s.languageFilled && (
            <label className="inline-flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="reviewed_filled" className="h-4 w-4" />
              <span>I have reviewed the {s.languageFilled === "en" ? "English" : "Urdu"} the worker wrote and take it as mine (clears the &ldquo;filled&rdquo; mark readers see).</span>
            </label>
          )}
          <ChoiceGroup legend="Section" name="group_id" defaultValue={String(s.groupId)} choices={groups.filter((g) => g.active || g.id === s.groupId).map((g) => ({ value: String(g.id), label: <>{g.nameEn} <span lang="ur" className="meta">{g.nameUr}</span></> }))} />
          <ChoiceGroup legend="Tag" name="tag" defaultValue={s.tag} choices={[{ value: "must-read", label: "Must read" }, { value: "worth-knowing", label: "Worth knowing" }, { value: "skim", label: "Skim" }]} />
          <ChoiceGroup legend="Coverage" name="coverage" defaultValue={s.coverage ?? "single-source"} choices={[{ value: "single-source", label: "Single source" }, { value: "broad", label: "Broad" }, { value: "partisan", label: "Partisan" }]} />
          <ChoiceGroup legend="Topics (up to 3)" name="topics" multiple defaultValues={s.topics} choices={TOPICS.map((t) => ({ value: t, label: <>{TOPIC_LABELS[t].en} <span lang="ur" className="meta">{TOPIC_LABELS[t].ur}</span></> }))} />
          <ChoiceGroup legend="Place in its section" name="position" defaultValue={s.order >= 50 ? "end" : "top"} choices={[{ value: "top", label: "At the top" }, { value: "end", label: "After the worker's stories" }]} />
          <div><Button tone="primary">Save changes</Button></div>
        </form>
      )}

      {canRemove && (
        <section aria-labelledby="rm" className="card mb-6 p-4">
          <h2 id="rm" className="mb-1 font-semibold">Remove</h2>
          <p className="meta mb-2">Deletes the story before anyone sees it. Its link stays in the sources (items are kept), and its queued jobs are cancelled.</p>
          <form action={removeManualStoryAction}><input type="hidden" name="id" value={s.id} /><ConfirmButton confirmLabel="Confirm: remove this story">Remove story</ConfirmButton></form>
        </section>
      )}

      <section aria-labelledby="hist">
        <h2 id="hist" className="mb-2 font-semibold">History</h2>
        {history.length === 0 ? <Empty>No recorded actions.</Empty> : (
          <ul className="card divide-y divide-rule text-sm">
            {history.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-3 px-3 py-2">
                <span className="meta whitespace-nowrap">{fmtDate(a.at)}</span>
                <span className="font-semibold">{a.userName || a.userEmail || "a removed account"}</span>
                <span>{a.action}</span>
                <span className="meta break-all">{summarise(a.detail)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AdminShell>
  );
}

function summarise(d: Record<string, unknown>): string {
  return Object.entries(d).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ").slice(0, 400);
}

function Text({ label, name, value, max, rows, ur }: { label: string; name: string; value: string; max: number; rows?: number; ur?: boolean }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-semibold">{label}</span>
      {rows
        ? <textarea name={name} defaultValue={value} maxLength={max} rows={rows} className={field} lang={ur ? "ur" : undefined} dir={ur ? "rtl" : undefined} />
        : <input name={name} defaultValue={value} maxLength={max} className={field} lang={ur ? "ur" : undefined} dir={ur ? "rtl" : undefined} />}
    </label>
  );
}

