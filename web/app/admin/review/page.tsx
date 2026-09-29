import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin/session";
import { roleAtLeast } from "@/lib/auth";
import { REVIEW_PAGE_MAX, REVIEW_TABS, reviewQueueCounts, reviewStories, type ReviewStory, type ReviewTab } from "@/lib/admin/review";
import { markEditionReviewedAction, markReviewedAction, restoreStoryAction, undoReviewAction } from "@/lib/admin/review-actions";
import { addCorrection } from "@/lib/admin/actions";
import { fmtDate } from "@/lib/admin/util";
import { mediaUrl, sortedVariants } from "@/lib/media";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Empty } from "@/components/admin/table";
import { Button, Input } from "@/components/admin/form";
import { WithdrawForm } from "@/components/admin/withdraw-form";
import { ChipNav, personLabel } from "../stories/_ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review" };

const TAB_LABEL: Record<ReviewTab, string> = { todo: "To review", reviewed: "Reviewed", withdrawn: "Withdrawn" };
/** The page's main action, filled (.chip's own colours are unlayered CSS, so they need the ! here). */
const PRIMARY = "!border-ink !bg-ink !text-paper";

/**
 * Review (decision D14 in docs/PLAN.md, lib/admin/review.ts). Editions publish without waiting for an editor
 * (Settings, publish policy); every AI-written story shows readers "Not reviewed yet" until someone here marks
 * it reviewed, and a QA-flagged one shows "Check raised a question" with the check's note. This page lists
 * them by edition, flagged first, with both languages, sources and image, and the editor's actions: mark
 * reviewed (one, or all shown in an edition), add a correction (appended, the text stays as published),
 * withdraw (a reason, then a confirm step). Owners can undo a review or a withdrawal. Everything is logged.
 */
export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin("/admin/review");
  const owner = roleAtLeast(user.role, "owner");
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const show = one(sp.show);
  const tab: ReviewTab = (REVIEW_TABS as readonly string[]).includes(show ?? "") ? (show as ReviewTab) : "todo";
  const edParam = Number(one(sp.edition));
  const editionId = Number.isInteger(edParam) && edParam > 0 && edParam <= 2_147_483_647 ? edParam : undefined;
  const [{ stories, more }, counts, flash] = await Promise.all([reviewStories(tab, editionId), reviewQueueCounts(), flashFrom(searchParams)]);
  const query = new URLSearchParams({ ...(tab !== "todo" ? { show: tab } : {}), ...(editionId ? { edition: String(editionId) } : {}) }).toString();
  const back = `/admin/review${query ? `?${query}` : ""}`;

  // Grouped by edition, in the order the query gave (newest edition first; in "To review", flagged first).
  const byEdition = new Map<number, ReviewStory[]>();
  for (const s of stories) byEdition.set(s.editionId, [...(byEdition.get(s.editionId) ?? []), s]);

  return (
    <AdminShell title="Review" flash={flash}>
      <p className="meta mb-3 max-w-3xl">
        Editions go out without waiting for you. Each AI-written story tells readers whether an editor has reviewed it
        (&ldquo;Not reviewed yet&rdquo; / &ldquo;ابھی ادارتی جائزہ نہیں ہوا&rdquo;), and a story the automatic check flagged also shows the
        check&apos;s note. Read each story against its sources, then mark it reviewed; if it is wrong, add a correction (the
        published text is never edited) or withdraw it. Manual entries are written by editors and are not listed here.
      </p>
      <ChipNav label="Review lists" items={REVIEW_TABS.map((t) => ({
        href: `/admin/review${t === "todo" ? "" : `?show=${t}`}`, current: t === tab,
        label: t === "todo" ? <>{TAB_LABEL[t]}{counts.flagged > 0 && <span className="text-accent"> · {counts.flagged} flagged</span>}</> : TAB_LABEL[t],
        count: t === "todo" ? counts.unreviewed : undefined,
      }))} />
      {editionId && <p className="meta mb-3">One edition only. <Link href={`/admin/review${tab === "todo" ? "" : `?show=${tab}`}`}>Show every edition</Link></p>}

      {stories.length === 0 ? (
        <Empty>{tab === "todo" ? "Nothing waits for review: every published AI-written story has been reviewed." : tab === "reviewed" ? "No reviewed stories yet." : "No story has been withdrawn."}</Empty>
      ) : (
        [...byEdition.entries()].map(([id, list]) => {
          const ed = list[0].edition;
          const flagged = list.filter((s) => s.qaStatus === "flagged").length;
          return (
            <section key={id} className="mb-8" aria-labelledby={`ed-${id}`}>
              <header className="rule-strong mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
                <h2 id={`ed-${id}`} className="text-lg font-bold">{ed.date} · <span className="capitalize">{ed.slot}</span></h2>
                <span className="meta">
                  {list.length} {list.length === 1 ? "story" : "stories"} {tab === "todo" ? "to review" : tab}
                  {flagged > 0 && <span className="text-accent"> · {flagged} flagged by QA</span>}
                  {ed.publishedAt && <> · published {fmtDate(ed.publishedAt)}</>}
                </span>
                <Link href={`/admin/editions/${id}`} className="meta">Edition in the admin</Link>
                {ed.status === "published" && <a href={`/en/${ed.date}/${ed.slot}`} target="_blank" rel="noreferrer" className="meta">On the site ↗</a>}
                {!editionId && <Link href={`/admin/review?${new URLSearchParams({ ...(tab !== "todo" ? { show: tab } : {}), edition: String(id) })}`} className="meta">Only this edition</Link>}
                {tab === "todo" && (
                  <form action={markEditionReviewedAction} className="ms-auto">
                    <input type="hidden" name="edition_id" value={id} /><input type="hidden" name="back" value={back} />
                    {list.map((s) => <input key={s.id} type="hidden" name="story_ids" value={s.id} />)}
                    <Button tone="primary" className={PRIMARY} title="Marks exactly the stories listed below for this edition">
                      Mark all {list.length} shown in this edition reviewed
                    </Button>
                  </form>
                )}
              </header>
              <div className="grid gap-4">
                {list.map((s) => <ReviewCard key={s.id} s={s} tab={tab} owner={owner} back={back} />)}
              </div>
            </section>
          );
        })
      )}
      {more && <p className="meta">Showing the first {REVIEW_PAGE_MAX}. Mark these reviewed (or pick one edition) to see the rest.</p>}
    </AdminShell>
  );
}

/** One story: its state, the QA note, both languages, image, sources, corrections, and the actions. */
function ReviewCard({ s, tab, owner, back }: { s: ReviewStory; tab: ReviewTab; owner: boolean; back: string }) {
  const img = s.image;
  const v = img ? sortedVariants(img)[0] : null;
  const live = !s.withdrawnAt && (s.edition.status === "published" || !!s.deskAt);
  const who = (p: { id: number; name: string; email: string } | null) => (p ? personLabel(p, owner) : null);
  const picture = img && v && (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={mediaUrl(v.file)} alt={img.alt ?? `Image from ${img.credit}`} width={v.w} height={v.h} loading="lazy" decoding="async"
      className="block rounded object-cover" style={{ background: img.color, inlineSize: "10rem", blockSize: "auto", maxBlockSize: "8rem" }} />
  );
  return (
    <article id={`story-${s.id}`} className={`card p-4 ${s.qaStatus === "flagged" && !s.reviewedAt ? "border-s-4 !border-s-warn" : ""}`} aria-labelledby={`t-${s.id}`}>
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <span className="meta">#{s.id} · {s.group.nameEn} · order {s.order}</span>
        {s.withdrawnAt
          ? <span className="pill pill-accent">withdrawn</span>
          : s.reviewedAt
            ? <span className="pill pill-soft text-ok">✓ reviewed</span>
            : s.qaStatus === "flagged"
              ? <span className="pill border border-warn text-warn">QA flagged · readers see &ldquo;Check raised a question&rdquo;</span>
              : <span className="pill pill-soft">not reviewed · readers see &ldquo;Not reviewed yet&rdquo;</span>}
        <span className={`pill ${s.tag === "must-read" ? "pill-accent" : "pill-soft"}`}>{s.tag}</span>
        {s.origin === "manual" && <span className="pill pill-soft">manual entry{s.createdByName ? ` · ${s.createdByName}` : ""}</span>}
        {s.thread && <span className="pill pill-soft">thread: {s.thread.slug}</span>}
        {live && <span className="meta ms-auto">Read as readers do: <a href={`/en/story/${s.id}`} target="_blank" rel="noreferrer">English ↗</a> · <a href={`/ur/story/${s.id}`} target="_blank" rel="noreferrer">اردو ↗</a></span>}
      </header>

      {s.reviewedAt && <p className="meta mb-2">Reviewed {fmtDate(s.reviewedAt)} by <bdi>{who(s.reviewer) ?? "an account since removed"}</bdi>; readers see &ldquo;Reviewed by {s.reviewer?.name.trim() || "an editor"}&rdquo;.</p>}
      {s.withdrawnAt && (
        <div className="mb-3 rounded border border-accent p-3 text-sm">
          <p><span className="font-semibold">Withdrawn</span> {fmtDate(s.withdrawnAt)} by <bdi>{who(s.withdrawer) ?? "an account since removed"}</bdi>. Its address shows readers only that it was withdrawn, the date and this note.</p>
          {s.withdrawNoteEn && <p className="mt-1"><span className="meta">Note (EN):</span> {s.withdrawNoteEn}</p>}
          {s.withdrawNoteUr && <p className="mt-1" lang="ur" dir="rtl"><span className="meta">نوٹ (اردو):</span> {s.withdrawNoteUr}</p>}
        </div>
      )}
      {s.qaStatus === "flagged" && (
        <div className="mb-3 rounded border border-warn bg-surface p-3 text-sm" role="note">
          <p><span className="font-semibold">The automatic check noted:</span> {s.qaNote.trim() || "(no note)"}</p>
          <p className="meta mt-1">Readers see this note on the story page{s.reviewedAt ? ", now with “an editor has since reviewed the story”" : " until you mark it reviewed, and after that with “an editor has since reviewed the story”"}.</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[auto_1fr_1fr]">
        <div className="min-w-0">
          {img ? (
            <>
              {img.graphic ? <details><summary className="cursor-pointer text-sm font-semibold text-accent">Sensitive image: show</summary><div className="mt-1">{picture}</div></details> : picture}
              <p className="meta mt-1 max-w-[10rem]">Image: {img.credit}{s.imageHiddenAt ? " (hidden from readers)" : ""}</p>
            </>
          ) : <p className="meta">No image</p>}
        </div>
        <div className="min-w-0" lang="en">
          <h3 id={`t-${s.id}`} className="font-semibold">{s.titleEn || "—"}</h3>
          <p className="mt-1 text-sm">{s.summaryEn}</p>
          {s.whyEn && <p className="mt-1 text-sm"><span className="meta">Why it matters:</span> {s.whyEn}</p>}
          {s.contestedEn && <p className="mt-1 text-sm"><span className="meta">Where outlets disagree:</span> {s.contestedEn}</p>}
        </div>
        <div className="min-w-0" lang="ur" dir="rtl">
          <h3 className="font-semibold leading-[2]">{s.titleUr || "—"}</h3>
          <p className="mt-1 text-sm leading-[2.2]">{s.summaryUr}</p>
          {s.whyUr && <p className="mt-1 text-sm leading-[2.2]"><span className="meta">یہ کیوں اہم ہے:</span> {s.whyUr}</p>}
          {s.contestedUr && <p className="mt-1 text-sm leading-[2.2]"><span className="meta">جہاں اداروں میں اختلاف ہے:</span> {s.contestedUr}</p>}
        </div>
      </div>

      <details className="mt-3" open={s.qaStatus === "flagged" && !s.reviewedAt && !s.withdrawnAt}>
        <summary className="cursor-pointer text-sm font-semibold">Sources ({s.sources.length}){s.posts.length ? ` · posts (${s.posts.length})` : ""}{s.angles.length ? ` · angles (${s.angles.length})` : ""}</summary>
        <ul className="mt-2 space-y-1 text-sm">
          {[...s.sources].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).map((x) => (
            <li key={x.item.id}>
              {x.isPrimary && <span className="pill pill-soft me-1">primary</span>}
              <span className="font-semibold">{x.item.source.name}</span>
              {x.item.source.perspective && <span className="meta"> ({x.item.source.perspective})</span>} ·{" "}
              <a href={x.item.url} target="_blank" rel="noreferrer" dir="auto">{x.item.title}</a> <span className="meta">{fmtDate(x.item.publishedAt)}</span>
              {x.item.text && <p className="meta ms-4 line-clamp-3" dir="auto">{x.item.text.slice(0, 400)}</p>}
            </li>
          ))}
          {s.posts.map((p) => <li key={p.post.id}><span className="pill pill-soft me-1">post</span>@{p.post.authorHandle}: <span dir="auto">{p.post.text.slice(0, 200)}</span> <a href={p.post.url} target="_blank" rel="noreferrer">↗</a></li>)}
          {s.angles.map((a, i) => <li key={i}><span className="pill pill-soft me-1">angle</span>item {a.itemId}: {a.noteEn}</li>)}
        </ul>
      </details>
      {s.corrections.length > 0 && (
        <ul className="mt-2 text-sm">
          {s.corrections.map((c) => <li key={c.id}><span className="meta">Correction {fmtDate(c.createdAt)}</span> · {c.textEn}{c.textUr && <span lang="ur" dir="rtl" className="ms-2">{c.textUr}</span>}</li>)}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-rule pt-3">
        {tab === "todo" && live && (
          <form action={markReviewedAction}>
            <input type="hidden" name="story_id" value={s.id} /><input type="hidden" name="back" value={back} />
            <Button tone="primary" className={PRIMARY}>Mark reviewed</Button>
          </form>
        )}
        {s.reviewedAt && !s.withdrawnAt && owner && (
          <form action={undoReviewAction}>
            <input type="hidden" name="story_id" value={s.id} /><input type="hidden" name="back" value={back} />
            <Button title="Owners only: readers see it as not reviewed again">Undo review</Button>
          </form>
        )}
        {s.withdrawnAt && owner && (
          <form action={restoreStoryAction}>
            <input type="hidden" name="story_id" value={s.id} /><input type="hidden" name="back" value={back} />
            <Button title="Owners only: the story returns to its edition, the feeds and search">Restore story (undo withdrawal)</Button>
          </form>
        )}
        {s.withdrawnAt && !owner && <p className="meta">Only an owner can restore a withdrawn story.</p>}
        {live && (
          <details className="min-w-0 basis-full sm:basis-auto">
            <summary className="chip inline-flex cursor-pointer font-semibold">Add correction…</summary>
            <form action={addCorrection} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <input type="hidden" name="story_id" value={s.id} /><input type="hidden" name="edition_id" value={s.editionId} /><input type="hidden" name="back" value={back} />
              <Input name="text_en" placeholder="Correction (English)" aria-label="Correction English" required maxLength={2000} />
              <Input name="text_ur" placeholder="تصحیح (اردو)" aria-label="Correction Urdu" lang="ur" dir="rtl" maxLength={2000} />
              <Button>Add correction</Button>
              <p className="meta sm:col-span-3">Appended under the story with today&apos;s date, in both languages when given. The story text stays as published.</p>
            </form>
          </details>
        )}
        {live && <WithdrawForm storyId={s.id} back={back} owner={owner} />}
      </div>
    </article>
  );
}
