"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { REPORT_TEXT_MAX } from "@/lib/codes";
import { reportMistake } from "@/lib/feedback-actions";
import { formatDate } from "@/lib/urdu";
import { TARGET } from "./save-button";

/*
 * "Report a mistake" / "غلطی کی نشاندہی" (decision D8): the reader's own words to the editors' queue
 * (/admin/reports). It is not a vote and is not shown to other readers. A button opens a short form; the
 * reader's earlier reports on this story are listed with where they stand. Errors are shown in the form
 * (empty, too long, the day's limit, the same text twice, offline); after sending, focus moves to the thank
 * you so a screen reader hears it, and Cancel returns it to the button that opened the form.
 */

type Previous = { id: number; at: string; status: "open" | "resolved" | "dismissed" };

export function ReportMistake({ storyId, previous = [] }: { storyId: number; previous?: Previous[] }) {
  const t = useTranslations("report");
  const locale = useLocale() as "en" | "ur";
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const formId = useId(), fieldId = useId(), hintId = useId(), errId = useId();
  const thanks = useRef<HTMLParagraphElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const length = [...text].length;
  // After sending, focus the thank-you once it is on the page (an effect, so it runs after React has drawn it).
  useEffect(() => { if (sent) thanks.current?.focus(); }, [sent]);
  const latest = previous[0];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!text.trim()) { setError(t("errors.empty")); field.current?.focus(); return; }
    if (length > REPORT_TEXT_MAX) { setError(t("errors.too_long", { max: REPORT_TEXT_MAX })); field.current?.focus(); return; }
    startTransition(async () => {
      try {
        const r = await reportMistake(storyId, { text, locale, next: window.location.pathname });
        if (!r) return; // sent to sign in
        if (r.ok) {
          setSent(true); setText(""); setOpen(false);
        } else {
          setError(r.error === "too_long" ? t("errors.too_long", { max: REPORT_TEXT_MAX }) : t(`errors.${r.error}`));
          field.current?.focus();
        }
      } catch {
        setError(navigator.onLine ? t("errors.generic") : t("errors.offline"));
      }
    });
  };

  return (
    <div className="no-print ui">
      {latest && !sent && (
        <p className="meta mb-2 measure">
          {t("previous", { count: previous.length, date: formatDate(new Date(latest.at), locale, { dateStyle: "medium" }) })} {t(`status.${latest.status}`)}
        </p>
      )}
      {sent && <p ref={thanks} tabIndex={-1} role="status" className="mb-2 measure text-ok">{t("sent")}</p>}
      {!open ? (
        <button ref={opener} type="button" onClick={() => { setOpen(true); setSent(false); requestAnimationFrame(() => field.current?.focus()); }} aria-expanded={false} aria-controls={formId}
          className={`chip cursor-pointer ${TARGET}`}>
          <FlagIcon /><span>{sent ? t("another") : t("open")}</span>
        </button>
      ) : (
        <form id={formId} onSubmit={submit} noValidate className="card mt-1 grid gap-2 p-3 sm:p-4" aria-labelledby={`${formId}-h`}>
          <h3 id={`${formId}-h`} className="font-semibold">{t("title")}</h3>
          <p className="meta measure">{t("intro")}</p>
          <label htmlFor={fieldId} className="font-semibold">{t("label")}</label>
          <textarea
            ref={field} id={fieldId} name="text" value={text} onChange={(e) => setText(e.target.value)} rows={4} dir="auto" required
            aria-describedby={`${hintId}${error ? ` ${errId}` : ""}`} aria-invalid={error ? true : undefined}
            className="min-h-28 w-full rounded-[var(--radius)] border border-rule bg-surface px-3 py-2 text-ink"
          />
          <p id={hintId} className={`meta ${length > REPORT_TEXT_MAX ? "text-warn" : ""}`}>{t("hint", { max: REPORT_TEXT_MAX, count: length })}</p>
          {error && <p id={errId} role="alert" className="text-warn">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={pending} className={`chip cursor-pointer font-semibold text-ink ${TARGET} disabled:opacity-60`}>{pending ? t("sending") : t("send")}</button>
            <button type="button" onClick={() => { setOpen(false); setError(null); requestAnimationFrame(() => opener.current?.focus()); }} className={`chip cursor-pointer ${TARGET}`}>{t("cancel")}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function FlagIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="1.05em" height="1.05em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </svg>
  );
}
