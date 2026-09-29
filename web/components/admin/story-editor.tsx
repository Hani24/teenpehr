import Link from "next/link";
import { updateStory, addCorrection, hideStoryImage } from "@/lib/admin/actions";
import { Field, Input, Textarea, Select, Button } from "@/components/admin/form";
import type { StoryFull } from "@/lib/queries";
import { fmtDate } from "@/lib/admin/util";
import { mediaUrl, sortedVariants } from "@/lib/media";
import { WithdrawForm } from "./withdraw-form";

/**
 * One story in the edition editor. `hiderName`: who hid its image, when it is hidden (a published story).
 * `owner`: the viewer is an owner (the withdraw form says who can undo it).
 */
export function StoryEditor({ story, editionId, editable, hiderName, owner = false }: { story: StoryFull; editionId: number; editable: boolean; hiderName?: string | null; owner?: boolean }) {
  const s = story;
  // Readers can see it (published, or live on the Editor's desk): review state and withdrawal apply (D14).
  const live = !editable || !!s.deskAt;
  return (
    <article id={`story-${s.id}`} className={`card p-4 ${s.withdrawnAt ? "opacity-70" : ""}`}>
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <span className="meta">#{s.id} · order {s.order}</span>
        {s.origin === "manual" && <span className="pill pill-soft">manual entry{s.createdByName ? ` · added by ${s.createdByName}` : ""}{s.placement === "desk" ? " · Editor's desk" : ""}</span>}
        <span className={`pill ${s.tag === "must-read" ? "pill-accent" : "pill-soft"}`}>{s.tag}</span>
        <span className={`pill pill-soft ${s.qaStatus === "flagged" ? "text-accent" : ""}`}>qa: {s.qaStatus}</span>
        {s.thread && <span className="pill pill-soft">thread: {s.thread.slug}</span>}
        {s.qaNote && <span className="meta">{s.qaNote}</span>}
      </header>
      {live && <ReviewState s={s} editionId={editionId} />}
      {editable && s.origin === "manual" ? (
        // D12: an editor's story has its own editor (language fill, placement, qa 'manual'); not this form.
        <div className="grid gap-3 sm:grid-cols-2">
          <p className="text-sm sm:col-span-2">An editor wrote this story by hand. <Link href={`/admin/stories/${s.id}`} className="font-semibold">Edit the manual story</Link> (its missing language is refilled from the editor&apos;s text there).</p>
          <div><h3 className="font-semibold">{s.titleEn || "—"}</h3><p className="mt-1 text-sm">{s.summaryEn}</p></div>
          <div lang="ur" dir="rtl"><h3 className="font-semibold leading-[2]">{s.titleUr || "—"}</h3><p className="mt-1 text-sm leading-[2.2]">{s.summaryUr}</p></div>
        </div>
      ) : editable ? (
        <form action={updateStory} className="grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="story_id" value={s.id} /><input type="hidden" name="edition_id" value={editionId} />
          <Field label="Title (EN)"><Input name="title_en" defaultValue={s.titleEn} required /></Field>
          <Field label="Title (UR)"><Input name="title_ur" defaultValue={s.titleUr} lang="ur" dir="rtl" /></Field>
          <Field label="Summary (EN)"><Textarea name="summary_en" defaultValue={s.summaryEn} required /></Field>
          <Field label="Summary (UR)"><Textarea name="summary_ur" defaultValue={s.summaryUr} lang="ur" dir="rtl" /></Field>
          <Field label="Why it matters (EN)"><Textarea name="why_en" defaultValue={s.whyEn} className="!min-h-16" /></Field>
          <Field label="Why it matters (UR)"><Textarea name="why_ur" defaultValue={s.whyUr} lang="ur" dir="rtl" className="!min-h-16" /></Field>
          <Field label="Contested (EN)"><Textarea name="contested_en" defaultValue={s.contestedEn} className="!min-h-16" /></Field>
          <Field label="Contested (UR)"><Textarea name="contested_ur" defaultValue={s.contestedUr} lang="ur" dir="rtl" className="!min-h-16" /></Field>
          <div className="grid grid-cols-2 gap-2 sm:col-span-2 sm:grid-cols-5">
            <Field label="Tag"><Select name="tag" defaultValue={s.tag} options={[["must-read", "must-read"], ["worth-knowing", "worth-knowing"], ["skim", "skim"]]} /></Field>
            <Field label="Coverage"><Select name="coverage" defaultValue={s.coverage ?? ""} options={[["", "—"], ["broad", "broad"], ["partisan", "partisan"], ["single-source", "single-source"]]} /></Field>
            <Field label="Order"><Input name="order" type="number" min={0} max={99} defaultValue={s.order} /></Field>
            <Field label="QA status"><Select name="qa_status" defaultValue={s.qaStatus} options={[["pending", "pending"], ["verified", "verified"], ["flagged", "flagged"]]} /></Field>
            <Field label="QA note"><Input name="qa_note" defaultValue={s.qaNote} /></Field>
          </div>
          <div className="sm:col-span-2"><Button tone="primary">Save story</Button></div>
        </form>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div><h3 className="font-semibold">{s.titleEn}</h3><p className="mt-1 text-sm">{s.summaryEn}</p>{s.whyEn && <p className="meta mt-1">Why: {s.whyEn}</p>}{s.contestedEn && <p className="meta mt-1">Contested: {s.contestedEn}</p>}</div>
          <div lang="ur" dir="rtl"><h3 className="font-semibold leading-[2]">{s.titleUr}</h3><p className="mt-1 text-sm leading-[2.2]">{s.summaryUr}</p></div>
        </div>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-semibold">Sources ({s.sources.length}) · posts ({s.posts.length}) · angles ({s.angles.length})</summary>
        <ul className="mt-2 space-y-1 text-sm">
          {s.sources.map((x) => <li key={x.item.id}>{x.isPrimary && <span className="pill pill-soft me-1">primary</span>}<span className="font-semibold">{x.item.source.name}</span> · <a href={x.item.url} target="_blank" rel="noreferrer">{x.item.title}</a> <span className="meta">{fmtDate(x.item.publishedAt)}</span></li>)}
          {s.posts.map((p) => <li key={p.post.id}><span className="pill pill-soft me-1">post</span>@{p.post.authorHandle}: {p.post.text.slice(0, 160)} <a href={p.post.url} target="_blank" rel="noreferrer">↗</a></li>)}
          {s.angles.map((a, i) => <li key={i}><span className="pill pill-soft me-1">angle</span>item {a.itemId}: {a.noteEn}</li>)}
        </ul>
      </details>
      <StoryImageAdmin story={s} editionId={editionId} published={!editable} hiderName={hiderName} />
      {s.corrections.length > 0 && (
        <ul className="mt-2 text-sm">{s.corrections.map((c) => <li key={c.id}><span className="meta">{fmtDate(c.createdAt)}</span> · {c.textEn}</li>)}</ul>
      )}
      {live && !s.withdrawnAt && <div className="mt-3"><WithdrawForm storyId={s.id} back={`/admin/editions/${editionId}#story-${s.id}`} owner={owner} /></div>}
      {!editable && (
        <form action={addCorrection} className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input type="hidden" name="story_id" value={s.id} /><input type="hidden" name="edition_id" value={editionId} />
          <Input name="text_en" placeholder="Correction (English)" aria-label="Correction English" required />
          <Input name="text_ur" placeholder="تصحیح (اردو)" aria-label="Correction Urdu" lang="ur" dir="rtl" />
          <Button>Add correction</Button>
        </form>
      )}
    </article>
  );
}

/** Where a live story's editorial review stands (D14), with the way to the Review page. */
function ReviewState({ s, editionId }: { s: StoryFull; editionId: number }) {
  if (s.withdrawnAt) {
    return (
      <p className="mb-2 rounded border border-accent p-2 text-sm">
        <span className="pill pill-accent me-1">withdrawn</span> {fmtDate(s.withdrawnAt)}: readers see only that it was withdrawn and why.
        {s.withdrawNoteEn && <> Note: {s.withdrawNoteEn}</>}{s.withdrawNoteUr && <span lang="ur" dir="rtl" className="ms-2">{s.withdrawNoteUr}</span>}{" "}
        <Link href="/admin/review?show=withdrawn">Withdrawn stories</Link>
      </p>
    );
  }
  if (s.origin === "manual") return null; // an editor wrote it: no review state
  return (
    <p className="mb-2 text-sm">
      {s.reviewedAt
        ? <><span className="pill pill-soft text-ok">✓ reviewed</span> {fmtDate(s.reviewedAt)}{s.reviewer?.name ? ` by ${s.reviewer.name}` : ""}</>
        : <><span className={`pill ${s.qaStatus === "flagged" ? "border border-warn text-warn" : "pill-soft"}`}>not reviewed</span> readers see &ldquo;{s.qaStatus === "flagged" ? "Check raised a question" : "Not reviewed yet"}&rdquo; · <Link href={`/admin/review?edition=${editionId}#story-${s.id}`}>Review it</Link></>}
    </p>
  );
}

/**
 * The story's publisher image (D6), as readers get it, with Hide image. A draft loses the image; on a
 * published story it is hidden from readers and the hide is kept with who and when (lib/admin/actions.ts
 * hideStoryImage). Sensitive images stay closed until opened here too.
 */
function StoryImageAdmin({ story: s, editionId, published, hiderName }: { story: StoryFull; editionId: number; published: boolean; hiderName?: string | null }) {
  const img = s.image;
  if (!img) return null;
  const v = sortedVariants(img)[0];
  const owner = img.itemId != null ? s.sources.find((x) => x.itemId === img.itemId)?.item : null;
  const post = img.postId != null ? s.posts.find((x) => x.postId === img.postId)?.post : null;
  const from = owner ? { label: `item #${owner.id}: ${owner.title}`, url: owner.url } : post ? { label: `post by @${post.authorHandle}`, url: post.url } : null;
  const picture = v && (
    // Sized inline: globals.css sets img { block-size: auto } outside any layer, which beats Tailwind's h-*.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={mediaUrl(v.file)} alt={img.alt ?? `Image from ${img.credit}`} width={v.w} height={v.h} loading="lazy" decoding="async"
      className="block rounded object-cover" style={{ background: img.color, blockSize: "6rem", inlineSize: "auto", maxInlineSize: "10rem" }} />
  );
  return (
    <section className="mt-3 flex flex-wrap items-start gap-3 rounded border border-rule p-3 text-sm" aria-label={`Image of story ${s.id}`}>
      <div className={s.imageHiddenAt ? "opacity-50" : undefined}>
        {img.graphic
          ? <details><summary className="cursor-pointer font-semibold text-accent">Sensitive: show</summary><div className="mt-1">{picture}</div></details>
          : picture}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p>
          <span className="font-semibold">Image</span> · credit <span className="font-semibold">{img.credit}</span> · {img.width}×{img.height}
          {img.graphic && <span className="pill pill-soft ms-1 text-accent" title="The vision check flagged it, or could not check it: readers see it blurred.">sensitive</span>}
          {from && <> · from <a href={from.url} target="_blank" rel="noreferrer">{from.label}</a></>}
        </p>
        <p className="meta">Alt text: {img.alt ?? `none from the publisher (readers get "Image from ${img.credit}")`}</p>
        {s.imageHiddenAt ? (
          <p><span className="pill pill-soft text-warn">hidden</span> Hidden from readers {fmtDate(s.imageHiddenAt)} by {hiderName ?? (s.imageHiddenBy ? `user #${s.imageHiddenBy}` : "an account since deleted")}. The story text is as published.</p>
        ) : published ? (
          // Two steps without client state: open, read what it does, confirm. (Not ConfirmButton: its first
          // click already submits, because React re-renders it as type="submit" inside that click.)
          <details>
            <summary className="chip inline-flex cursor-pointer font-semibold text-accent">Hide image…</summary>
            <form action={hideStoryImage} className="mt-2 flex flex-wrap items-center gap-2">
              <input type="hidden" name="story_id" value={s.id} /><input type="hidden" name="edition_id" value={editionId} />
              <p className="meta basis-full">The story text stays as published. Readers stop seeing this image on every page, in downloads and in offline copies as they refresh; your name and the time are recorded here. There is no undo.</p>
              <Button tone="danger">Confirm: hide from readers</Button>
            </form>
          </details>
        ) : (
          <form action={hideStoryImage} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="story_id" value={s.id} /><input type="hidden" name="edition_id" value={editionId} />
            <Button>Hide image</Button>
            <span className="meta">Removes the image from this draft story; the text is not touched. A worker rerun of this slot may choose an image again.</span>
          </form>
        )}
      </div>
    </section>
  );
}
