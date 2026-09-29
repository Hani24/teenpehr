"use client";
import { useActionState, useEffect, useRef, useState, startTransition } from "react";
import Link from "next/link";
import { checkManualLink, createManualStoryAction, type CreateState, type LinkCheckState } from "@/lib/admin/manual-actions";
import { ChoiceGroup, ManualTag } from "../_ui";

type Dest = { id: number | null; label: string; stories: number };
type Upload = { json: string; sig: string; preview: { file: string; w: number; h: number; width: number; height: number; color: string; variants: number } };

const field = "w-full rounded border border-rule bg-surface px-2 py-2 text-ink focus:border-focus";
const LIMITS = { title: 300, summary: 3000, why: 1000, contested: 1000 } as const;
type TextKey = `${keyof typeof LIMITS}_${"en" | "ur"}`;
const EMPTY: Record<TextKey, string> = { title_en: "", summary_en: "", why_en: "", contested_en: "", title_ur: "", summary_ur: "", why_ur: "", contested_ur: "" };

/**
 * The manual-entry form (D12). The link is checked once (checkManualLink) and its preview prefills empty
 * fields; the preview travels back signed so the create step does not fetch again. An upload goes to
 * /admin/stories/image first (it may be larger than a Server Action accepts) and comes back as a signed
 * token. Submitting never resets the form: on an error everything the editor typed stays.
 */
export function ManualStoryForm({ byline, hasName, groups, topics, upcoming, held, destinationError }: {
  byline: string; hasName: boolean;
  groups: Array<{ id: number; nameEn: string; nameUr: string }>;
  topics: Array<{ value: string; en: string; ur: string }>;
  upcoming: Dest | null; held: Dest[]; destinationError: string | null;
}) {
  const [check, runCheck, checking] = useActionState<LinkCheckState, FormData>(checkManualLink, null);
  const [created, runCreate, creating] = useActionState<CreateState, FormData>(createManualStoryAction, null);
  const [link, setLink] = useState("");
  const [text, setText] = useState(EMPTY);
  const [imageMode, setImageMode] = useState<"none" | "article" | "upload">("none");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [credit, setCredit] = useState("");
  const [placement, setPlacement] = useState<"desk" | "edition">("edition");
  const [edition, setEdition] = useState<string>(upcoming ? "upcoming" : held[0] ? String(held[0].id) : "upcoming");
  const [uncheckedOk, setUncheckedOk] = useState(false);
  const applied = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // A preview fills only what the editor has not typed yet, once per checked link.
  useEffect(() => {
    if (!check?.ok || applied.current === check.json) return;
    applied.current = check.json;
    const p = check.preview;
    const side = p.lang === "ur" ? "ur" : "en";
    setText((t) => ({
      ...t,
      [`title_${side}`]: t[`title_${side}` as TextKey] || p.title,
      [`summary_${side}`]: t[`summary_${side}` as TextKey] || p.description,
    }));
    setCredit((c) => c || check.outlet?.name || p.siteName || hostOf(p.finalUrl));
  }, [check]);

  useEffect(() => () => { if (localPreview) URL.revokeObjectURL(localPreview); }, [localPreview]);

  const checkedThisLink = check?.ok && check.preview.url === link.trim();
  const checkFailedThisLink = check && !check.ok && check.link === link.trim();
  const showOverride = (checkFailedThisLink && check.overridable) || created?.needsOverride;

  function doCheck() {
    const fd = new FormData();
    fd.set("link", link.trim());
    startTransition(() => runCheck(fd));
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => runCreate(fd));
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    setUpload(null); setUploadError("");
    if (localPreview) URL.revokeObjectURL(localPreview);
    setLocalPreview(file ? URL.createObjectURL(file) : null);
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setUploadError("The image is larger than 8 MB."); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/admin/stories/image", { method: "POST", body: fd, credentials: "same-origin" });
      const body = await res.json().catch(() => null) as ({ ok: true } & Upload) | { ok: false; error: string } | null;
      if (!body) setUploadError(`Upload failed (HTTP ${res.status}).`);
      else if (!body.ok) setUploadError(body.error);
      else setUpload({ json: body.json, sig: body.sig, preview: body.preview });
    } catch {
      setUploadError("Upload failed: the connection dropped. Try again.");
    } finally {
      setUploading(false);
    }
  }

  const set = (k: TextKey) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { const v = e.currentTarget.value; setText((t) => ({ ...t, [k]: v })); };
  const has = (lang: "en" | "ur") => (["title", "summary", "why", "contested"] as const).some((f) => text[`${f}_${lang}`].trim());
  const missing = !has("en") ? "English" : !has("ur") ? "Urdu" : null;

  return (
    <form ref={formRef} onSubmit={submit} className="grid max-w-5xl gap-6" noValidate>
      {/* 1. the link */}
      <section aria-labelledby="s-link" className="card grid gap-3 p-4">
        <h2 id="s-link" className="font-semibold">1. Link to the article <span className="text-accent">(required)</span></h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-0 flex-1 text-sm">
            <span className="mb-1 block font-semibold">Article link</span>
            <input name="link" type="url" inputMode="url" required maxLength={2000} value={link} onChange={(e) => setLink(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doCheck(); } }}
              placeholder="https://www.example.com/news/…" className={field} dir="ltr" autoComplete="off" />
          </label>
          <button type="button" onClick={doCheck} disabled={checking || !link.trim()} className="chip min-h-11 cursor-pointer px-4 font-semibold disabled:opacity-60">
            {checking ? "Checking…" : "Check link"}
          </button>
        </div>
        <p className="meta">Fetched once from our server, when the site&apos;s robots.txt allows it, to confirm the article exists and to fill in its title, description and outlet. Nothing else is taken from the page.</p>
        <div aria-live="polite">
          {checkedThisLink && check?.ok && (
            <div className="rounded border border-ok p-3 text-sm">
              <p className="font-semibold text-ok">Found (HTTP {check.preview.status}).</p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="meta">Title</dt><dd><bdi>{check.preview.title || "— none —"}</bdi></dd>
                <dt className="meta">Outlet</dt><dd>{check.outlet ? <>{check.outlet.name}{check.outlet.perspective && <span className="meta"> · {check.outlet.perspective}</span>}</> : <>{check.preview.siteName || hostOf(check.preview.finalUrl)} <span className="meta">(new to Tabayyun: stored as an inactive manual source)</span></>}</dd>
                <dt className="meta">Language</dt><dd>{check.preview.lang}</dd>
                <dt className="meta">Published</dt><dd>{check.preview.publishedAt ? new Date(check.preview.publishedAt).toLocaleString("en-GB", { timeZone: "Asia/Karachi" }) : "not stated"}</dd>
                <dt className="meta">Image</dt><dd>{check.preview.image ? "the article has one (you can use it below)" : "none found"}</dd>
                {check.preview.finalUrl !== check.preview.url && <><dt className="meta">Goes to</dt><dd className="break-all">{check.preview.finalUrl}</dd></>}
              </dl>
              {check.item && <p className="meta mt-2">Already in Tabayyun&apos;s sources (item #{check.item.id} from {check.item.source}): the story will cite that item.</p>}
              <p className="meta mt-2">The fields below were filled from the page where empty. Rewrite them in Tabayyun&apos;s neutral style; do not copy the outlet&apos;s text wholesale.</p>
            </div>
          )}
          {checkFailedThisLink && check && !check.ok && <p role="alert" className="rounded border border-accent p-3 text-sm text-accent">{check.message}</p>}
        </div>
        {showOverride && (
          <label className="inline-flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="unchecked_ok" checked={uncheckedOk} onChange={(e) => setUncheckedOk(e.currentTarget.checked)} className="h-4 w-4" />
            <span><strong>Add it anyway:</strong> I opened this article myself and it is real (the link is kept as unchecked in the record).</span>
          </label>
        )}
        {checkedThisLink && check?.ok && <><input type="hidden" name="preview_json" value={check.json} /><input type="hidden" name="preview_sig" value={check.sig} /></>}
      </section>

      {/* 2. the story */}
      <section aria-labelledby="s-text" className="card grid gap-4 p-4">
        <h2 id="s-text" className="font-semibold">2. The story</h2>
        <p className="meta">Write English, Urdu or both. Leave one language completely empty and the worker writes it from your text only (no new facts); it is marked as filled.
          {missing && <> <strong>{missing}</strong> will be written by the worker.</>}</p>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-3">
            <h3 className="font-semibold">English</h3>
            <TextField label="Title" name="title_en" value={text.title_en} onChange={set("title_en")} max={LIMITS.title} />
            <TextField label="Summary" hint="Two or three sentences, with attribution (“the ministry said…”)." name="summary_en" value={text.summary_en} onChange={set("summary_en")} max={LIMITS.summary} area rows={5} />
            <TextField label="Why it matters (optional)" name="why_en" value={text.why_en} onChange={set("why_en")} max={LIMITS.why} area rows={2} />
            <TextField label="What is contested (optional)" name="contested_en" value={text.contested_en} onChange={set("contested_en")} max={LIMITS.contested} area rows={2} />
          </div>
          <div className="grid content-start gap-3" lang="ur" dir="rtl">
            <h3 className="font-semibold">اردو</h3>
            <TextField label="سرخی" name="title_ur" value={text.title_ur} onChange={set("title_ur")} max={LIMITS.title} ur />
            <TextField label="خلاصہ" name="summary_ur" value={text.summary_ur} onChange={set("summary_ur")} max={LIMITS.summary} area rows={5} ur />
            <TextField label="یہ کیوں اہم ہے (اختیاری)" name="why_ur" value={text.why_ur} onChange={set("why_ur")} max={LIMITS.why} area rows={2} ur />
            <TextField label="کیا متنازع ہے (اختیاری)" name="contested_ur" value={text.contested_ur} onChange={set("contested_ur")} max={LIMITS.contested} area rows={2} ur />
          </div>
        </div>
        <p className="meta">If you write both languages, write &ldquo;why it matters&rdquo; and &ldquo;contested&rdquo; in both, or readers of the other language see none.</p>
      </section>

      {/* 3. filing */}
      <section aria-labelledby="s-file" className="card grid gap-4 p-4">
        <h2 id="s-file" className="font-semibold">3. Section and labels</h2>
        <ChoiceGroup legend="Section" name="group_id" required choices={groups.map((g) => ({ value: String(g.id), label: <>{g.nameEn} <span lang="ur" className="meta">{g.nameUr}</span></> }))} defaultValue={groups.length === 1 ? String(groups[0].id) : undefined} />
        <ChoiceGroup legend="Tag" name="tag" defaultValue="worth-knowing" choices={[
          { value: "must-read", label: "Must read" }, { value: "worth-knowing", label: "Worth knowing" }, { value: "skim", label: "Skim" },
        ]} />
        <ChoiceGroup legend="Coverage" name="coverage" defaultValue="single-source" hint="From one link this is usually single-source." choices={[
          { value: "single-source", label: "Single source" }, { value: "broad", label: "Broad" }, { value: "partisan", label: "Partisan" },
        ]} />
        <ChoiceGroup legend="Topics (optional, up to 3)" name="topics" multiple hint="Used for insights and the topic pages." choices={topics.map((t) => ({ value: t.value, label: <>{t.en} <span lang="ur" className="meta">{t.ur}</span></> }))} />
        <ChoiceGroup legend="Place in its section" name="position" defaultValue="top" choices={[{ value: "top", label: "At the top" }, { value: "end", label: "After the worker's stories" }]} />
      </section>

      {/* 4. image */}
      <section aria-labelledby="s-img" className="card grid gap-3 p-4">
        <h2 id="s-img" className="font-semibold">4. Image (optional)</h2>
        <ChoiceGroup legend="Image" name="image" value={imageMode} onChange={(v) => setImageMode(v as typeof imageMode)} choices={[
          { value: "none", label: "No image" },
          { value: "article", label: "Use the article's image", hint: "The worker fetches it from the link (politely, like any article) and checks it." },
          { value: "upload", label: "Upload an image", hint: "JPEG, PNG, WebP, AVIF or GIF, up to 8 MB; re-encoded and stripped of metadata." },
        ]} />
        {imageMode === "upload" && (
          <div className="grid gap-3 rounded border border-rule p-3">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold">Image file</span>
              <input type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif" onChange={onFile} className="block text-sm" />
            </label>
            <div aria-live="polite" className="text-sm">
              {uploading && <p>Processing the image…</p>}
              {uploadError && <p role="alert" className="text-accent">{uploadError}</p>}
              {upload && <p className="text-ok">Ready: {upload.preview.width}×{upload.preview.height}, {upload.preview.variants} size{upload.preview.variants > 1 ? "s" : ""}, metadata removed.</p>}
            </div>
            {(upload || localPreview) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={upload ? `/media/${upload.preview.file}` : localPreview!} alt="The chosen image" className="block rounded object-contain"
                style={{ background: upload?.preview.color, blockSize: "8rem", inlineSize: "auto", maxInlineSize: "16rem" }} />
            )}
            <label className="block text-sm">
              <span className="mb-1 block font-semibold">Credit (whose image it is)</span>
              <input name="image_credit" value={credit} onChange={(e) => setCredit(e.currentTarget.value)} maxLength={120} className={field} />
              <span className="meta mt-1 block">Readers see &ldquo;Image: {credit || "…"}&rdquo;, linking to the article.</span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold">Alt text (optional)</span>
              <input name="image_alt" maxLength={500} className={field} placeholder="What the picture shows, for people who cannot see it" />
            </label>
            <label className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="image_graphic" className="h-4 w-4" /><span>Sensitive image: blur it until the reader taps (hidden in Wazeh until tapped)</span></label>
            <label className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="image_rights" className="h-4 w-4" /><span>This is the article&apos;s own picture, or we have the right to use it.</span></label>
            {upload && <><input type="hidden" name="image_json" value={upload.json} /><input type="hidden" name="image_sig" value={upload.sig} /></>}
          </div>
        )}
      </section>

      {/* 5. where it goes */}
      <section aria-labelledby="s-dest" className="card grid gap-3 p-4">
        <h2 id="s-dest" className="font-semibold">5. Where it goes</h2>
        {destinationError && <p role="alert" className="text-sm text-accent">Could not work out the next edition: {destinationError}</p>}
        <ChoiceGroup legend="Publish" name="placement" value={placement} onChange={(v) => setPlacement(v as "desk" | "edition")} choices={[
          { value: "edition", label: "Add to an edition", hint: "Goes out with that edition. Worker reruns keep it." },
          { value: "desk", label: "Publish now on the Editor's desk", hint: "Live on the front page as soon as it is ready; from then on it can only be corrected, not edited. It joins the next edition that publishes.", disabled: !upcoming },
        ]} />
        {placement === "edition" && (
          <ChoiceGroup legend="Edition" name="edition" value={edition} onChange={(v) => setEdition(v)} choices={[
            ...(upcoming ? [{ value: "upcoming", label: `Next edition: ${upcoming.label}`, hint: upcoming.id ? `${upcoming.stories} stories so far` : "Not started yet: a draft is created for it" }] : []),
            ...held.map((h) => ({ value: String(h.id), label: `Held for review: ${h.label}`, hint: `${h.stories} stories` })),
          ]} />
        )}
        {placement === "desk" && <input type="hidden" name="edition" value="upcoming" />}
      </section>

      <section aria-labelledby="s-go" className="grid gap-3">
        <h2 id="s-go" className="sr-only">Add the story</h2>
        <div className="card grid gap-2 p-4">
          <p className="text-sm font-semibold">Readers will see it tagged:</p>
          <ManualTag name={byline} />
          <p className="meta">with the disclosure that an editor wrote it (not AI), and the link as its cited source. It is never marked as AI-verified.
            {!hasName && <> You have no display name, so it says &ldquo;{byline}&rdquo;: set your name under <Link href="/en/account">Your account</Link>.</>}</p>
        </div>
        <div aria-live="polite">{created?.error && <p role="alert" className="rounded border border-accent p-3 text-sm text-accent">{created.error}</p>}</div>
        <div>
          <button type="submit" disabled={creating || uploading} className="chip min-h-11 cursor-pointer border-ink bg-ink px-5 font-semibold text-paper disabled:opacity-60">
            {creating ? "Adding…" : placement === "desk" ? "Add and publish on the desk" : "Add to the edition"}
          </button>
        </div>
      </section>
    </form>
  );
}

function TextField({ label, hint, name, value, onChange, max, area, rows, ur }: {
  label: string; hint?: string; name: TextKey; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  max: number; area?: boolean; rows?: number; ur?: boolean;
}) {
  const left = max - value.length;
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-semibold">{label}</span>
      {area
        ? <textarea name={name} value={value} onChange={onChange} maxLength={max} rows={rows} className={field} lang={ur ? "ur" : undefined} dir={ur ? "rtl" : undefined} />
        : <input name={name} value={value} onChange={onChange} maxLength={max} className={field} lang={ur ? "ur" : undefined} dir={ur ? "rtl" : undefined} />}
      {hint && <span className="meta mt-1 block">{hint}</span>}
      {left < 100 && <span className="meta mt-1 block" dir="ltr">{left} characters left</span>}
    </label>
  );
}

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}
