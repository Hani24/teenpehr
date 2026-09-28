"use client";
import { useId, useOptimistic, useState, useSyncExternalStore, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toggleSaveEdition, toggleSaveStory } from "@/lib/saved-actions";
import { syncOfflineSoon } from "./sw-register";

/*
 * Save / unsave a story or an edition (decision D3). A toggle button: the label stays "Save" and
 * aria-pressed carries the state (the pressed look is the site's usual inverted chip, with a filled
 * bookmark), and a polite status line says what happened. The flip is optimistic and reverts on
 * failure, with the reason shown (offline, or try again).
 *
 * Targets: at least 44 px everywhere, and at least 48 px in the Wazeh reading mode (data-mode on
 * <html>), where a .chip grows to max(48px, 2.4em); the important 44 px floor would otherwise win.
 */
export const TARGET = "!min-h-11 wazeh:!min-h-[max(48px,2.4em)] wazeh:!min-w-12";
export const PRESSED = "!border-rule-strong !bg-ink !text-paper";

// What this document has learned from clicks, shared by every button for the same item: a card and
// a page header agree, and a page the router restores from its cache shows the latest state.
const known = new Map<string, boolean>();
const listeners = new Set<() => void>();
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
function learn(key: string, saved: boolean) { known.set(key, saved); listeners.forEach((l) => l()); }

type Props = {
  kind: "story" | "edition";
  id: number;
  /** Saved state from the server render. */
  saved: boolean;
  /** Visible label; defaults to "Save". */
  label?: string;
  /** Id of the element naming the item (a card's headline), appended to the accessible name. */
  labelledBy?: string;
  className?: string;
};

export function SaveButton({ kind, id, saved: fromServer, label, labelledBy, className = "" }: Props) {
  const t = useTranslations("saved");
  const locale = useLocale() as "en" | "ur";
  const key = `${kind}:${id}`;
  const learned = useSyncExternalStore(subscribe, () => known.get(key), () => undefined);
  const saved = learned ?? fromServer;
  const [shown, setShown] = useOptimistic(saved);
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const textId = useId();

  const onClick = () => {
    const want = !shown;
    setStatus(null);
    startTransition(async () => {
      setShown(want);
      try {
        const action = kind === "story" ? toggleSaveStory : toggleSaveEdition;
        const r = await action(id, { save: want, locale, next: window.location.pathname + window.location.search });
        if (!r) return; // sent to sign in
        if (r.ok) {
          learn(key, r.saved);
          syncOfflineSoon(locale); // keep the new shelf offline now, not at the next sync
          setStatus({ text: r.saved ? t("savedNotice") : t("removedNotice"), error: false });
        } else {
          setStatus({ text: r.error === "not_found" ? t("errorNotFound") : t("errorGeneric"), error: true });
        }
      } catch {
        setStatus({ text: navigator.onLine ? t("errorGeneric") : t("errorOffline"), error: true });
      }
    });
  };

  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}>
      <button type="button" onClick={onClick} aria-pressed={shown} aria-labelledby={labelledBy ? `${textId} ${labelledBy}` : undefined}
        className={`chip ui cursor-pointer font-semibold ${TARGET} ${shown ? PRESSED : ""}`}>
        <BookmarkIcon filled={shown} />
        <span id={textId}>{label ?? t("save")}</span>
      </button>
      {/* Always mounted, so screen readers hear the change; visible only for errors. */}
      <span role="status" className={status?.error ? "meta ui text-warn" : "sr-only"}>{status?.text ?? ""}</span>
    </span>
  );
}

function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="1.1em" height="1.1em" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" className="shrink-0">
      <path d="M6 3.5h12v17l-6-4.2-6 4.2z" />
      {filled && <path d="m9 10 2.2 2.2L15.5 8" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}
