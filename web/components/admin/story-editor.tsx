import { updateStory, addCorrection } from "@/lib/admin/actions";
import { Field, Input, Textarea, Select, Button } from "@/components/admin/form";
import type { StoryFull } from "@/lib/queries";
import { fmtDate } from "@/lib/admin/util";

export function StoryEditor({ story, editionId, editable }: { story: StoryFull; editionId: number; editable: boolean }) {
  const s = story;
  return (
    <article id={`story-${s.id}`} className="card p-4">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <span className="meta">#{s.id} · order {s.order}</span>
        <span className={`pill ${s.tag === "must-read" ? "pill-accent" : "pill-soft"}`}>{s.tag}</span>
        <span className={`pill pill-soft ${s.qaStatus === "flagged" ? "text-accent" : ""}`}>qa: {s.qaStatus}</span>
        {s.thread && <span className="pill pill-soft">thread: {s.thread.slug}</span>}
        {s.qaNote && <span className="meta">{s.qaNote}</span>}
      </header>
      {editable ? (
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
          <div lang="ur" dir="rtl"><h3 className="font-semibold">{s.titleUr}</h3><p className="mt-1 text-sm">{s.summaryUr}</p></div>
        </div>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-semibold">Sources ({s.sources.length}) · posts ({s.posts.length}) · angles ({s.angles.length})</summary>
        <ul className="mt-2 space-y-1 text-sm">
          {s.sources.map((x) => <li key={x.item.id}>{x.isPrimary && <span className="pill pill-soft mr-1">primary</span>}<span className="font-semibold">{x.item.source.name}</span> · <a href={x.item.url} target="_blank" rel="noreferrer">{x.item.title}</a> <span className="meta">{fmtDate(x.item.publishedAt)}</span></li>)}
          {s.posts.map((p) => <li key={p.post.id}><span className="pill pill-soft mr-1">post</span>@{p.post.authorHandle}: {p.post.text.slice(0, 160)} <a href={p.post.url} target="_blank" rel="noreferrer">↗</a></li>)}
          {s.angles.map((a, i) => <li key={i}><span className="pill pill-soft mr-1">angle</span>item {a.itemId}: {a.noteEn}</li>)}
        </ul>
      </details>
      {s.corrections.length > 0 && (
        <ul className="mt-2 text-sm">{s.corrections.map((c) => <li key={c.id}><span className="meta">{fmtDate(c.createdAt)}</span> · {c.textEn}</li>)}</ul>
      )}
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
