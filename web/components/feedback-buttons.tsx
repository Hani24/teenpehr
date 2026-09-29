"use client";
import { useId, useOptimistic, useState, useSyncExternalStore, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { FEEDBACK_REASONS, type FeedbackReason } from "@/lib/codes";
import { setStoryFeedback } from "@/lib/feedback-actions";
import { PRESSED, TARGET } from "./save-button";

/*
 * Relevance feedback on a story (decision D8): two labelled toggle buttons, "Relevant to me" and "Show less
 * like this", never bare thumbs that could read as approving or disapproving of the event. One answer per
 * reader per story: pressing the other button changes it, pressing the pressed one takes it back. "Show
 * less" opens optional reasons (topic, outlet, too much of this, not for me), each a toggle saved at once.
 * Every change is optimistic and reverts on failure, with the reason shown; confirmations go to screen
 * readers through a polite status line. Targets are 44px, and 48px in Wazeh (TARGET).
 *
 * The answers are private (the reader and the site's owners) and never hide a story from the edition.
 */

export type Vote = { value: 1 | -1; reasons: FeedbackReason[] } | null;

// What this document has learned from clicks, shared by every set of buttons for the same story (a story can
// be on an edition page twice: in "need to know" and in its section), so they always agree.
const known = new Map<number, Vote>();
const listeners = new Set<() => void>();
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
function learn(id: number, v: Vote) { known.set(id, v); listeners.forEach((l) => l()); }

type Props = {
  storyId: number;
  /** The reader's answer from the server render (null: none yet). */
  vote: Vote;
  /** Id of the element naming the story (a card's headline), added to each button's accessible name. */
  labelledBy?: string;
  /** "page": the story page (the note on privacy always shown); "card": an edition or section card. */
  variant?: "card" | "page";
  className?: string;
};

export function FeedbackButtons({ storyId, vote: fromServer, labelledBy, variant = "card", className = "" }: Props) {
  const t = useTranslations("feedback");
  const locale = useLocale() as "en" | "ur";
  const learned = useSyncExternalStore(subscribe, () => known.get(storyId), () => undefined);
  const vote = learned === undefined ? fromServer : learned;
  const [shown, setShown] = useOptimistic(vote);
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const upId = useId(), downId = useId(), whyId = useId(), panelId = useId();

  const send = (want: Vote, done: string) => {
    setStatus(null);
    startTransition(async () => {
      setShown(want);
      try {
        const r = await setStoryFeedback(storyId, { value: want?.value ?? 0, reasons: want?.reasons ?? [], locale, next: window.location.pathname + window.location.search });
        if (!r) return; // sent to sign in
        if (r.ok) {
          learn(storyId, r.value === 0 ? null : { value: r.value, reasons: r.reasons });
          setStatus({ text: done, error: false });
        } else {
          setStatus({ text: r.error === "not_found" ? t("errors.notFound") : t("errors.generic"), error: true });
        }
      } catch {
        setStatus({ text: navigator.onLine ? t("errors.generic") : t("errors.offline"), error: true });
      }
    });
  };

  const choose = (value: 1 | -1) => {
    if (shown?.value === value) { setOpen(false); send(null, t("removed")); return; }
    // Switching to "Show less" opens the optional reasons; switching away clears them.
    setOpen(value === -1);
    send({ value, reasons: value === -1 && shown?.value === -1 ? shown.reasons : [] }, value === 1 ? t("savedUp") : t("savedDown"));
  };
  const toggleReason = (r: FeedbackReason) => {
    if (shown?.value !== -1) return;
    const has = shown.reasons.includes(r);
    const reasons = FEEDBACK_REASONS.filter((x) => (x === r ? !has : shown.reasons.includes(x)));
    send({ value: -1, reasons }, t("reasonsSaved"));
  };

  const named = (id: string) => (labelledBy ? `${id} ${labelledBy}` : undefined);
  const chip = `chip ui cursor-pointer font-semibold ${TARGET}`;
  const down = shown?.value === -1;
  return (
    <div className={`no-print ${className}`}>
      <div role="group" aria-label={t("group")} className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => choose(1)} aria-pressed={shown?.value === 1} aria-labelledby={named(upId)} className={`${chip} ${shown?.value === 1 ? PRESSED : ""}`}>
          <RelevantIcon on={shown?.value === 1} /><span id={upId}>{t("up")}</span>
        </button>
        <button type="button" onClick={() => choose(-1)} aria-pressed={down} aria-labelledby={named(downId)} className={`${chip} ${down ? PRESSED : ""}`}>
          <LessIcon on={down} /><span id={downId}>{t("down")}</span>
        </button>
        {down && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={panelId} aria-labelledby={named(whyId)} className={`chip ui cursor-pointer ${TARGET}`}>
            <span id={whyId}>{t("whyToggle")}</span><span aria-hidden="true">{open ? "▴" : "▾"}</span>
          </button>
        )}
        {/* Always mounted, so screen readers hear each change; visible only for errors. */}
        <span role="status" className={status?.error ? "meta ui text-warn" : "sr-only"}>{status?.text ?? ""}</span>
      </div>
      {down && open && (
        <div id={panelId} role="group" aria-labelledby={`${panelId}-l`} className="mt-2">
          <p id={`${panelId}-l`} className="meta">{t("why")}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {FEEDBACK_REASONS.map((r) => {
              const on = shown.reasons.includes(r);
              return (
                <button key={r} type="button" onClick={() => toggleReason(r)} aria-pressed={on} className={`chip ui cursor-pointer ${TARGET} ${on ? PRESSED : ""}`}>
                  {on && <span aria-hidden="true">✓</span>}<span>{t(`reasons.${r}`)}</span>
                </button>
              );
            })}
          </div>
          {variant === "card" && <p className="meta mt-2 measure">{t("privacy")}</p>}
        </div>
      )}
      {variant === "page" && <p className="meta mt-2 measure">{t("privacy")}</p>}
    </div>
  );
}

/** A plus in a circle, filled when pressed: "this matters to me", not a thumbs-up. */
function RelevantIcon({ on }: { on: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
      <circle cx="12" cy="12" r="9" fill={on ? "currentColor" : "none"} />
      <path d="M12 8v8M8 12h8" stroke={on ? "var(--ink)" : "currentColor"} />
    </svg>
  );
}
/** A minus in a circle, filled when pressed: "fewer of these", not a thumbs-down. */
function LessIcon({ on }: { on: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
      <circle cx="12" cy="12" r="9" fill={on ? "currentColor" : "none"} />
      <path d="M8 12h8" stroke={on ? "var(--ink)" : "currentColor"} />
    </svg>
  );
}
