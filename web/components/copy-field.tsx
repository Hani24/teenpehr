"use client";
import { useId, useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * A read-only field holding a link, with a Copy button once scripts run (without them the text is
 * still selectable). Selecting the field on focus makes a manual copy one gesture.
 */
export function CopyField({ label, value, copyLabel, copiedLabel }: { label: string; value: string; copyLabel: string; copiedLabel: string }) {
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      (document.getElementById(id) as HTMLInputElement | null)?.select();
    }
  };
  return (
    <div className="mt-4 first:mt-0">
      <label htmlFor={id} className="ui block font-semibold">{label}</label>
      <div className="mt-1.5 flex items-stretch gap-2">
        <input id={id} value={value} readOnly dir="ltr" onFocus={(e) => e.currentTarget.select()}
          className="latin min-h-12 w-full min-w-0 flex-1 rounded-[var(--radius)] border-2 border-rule bg-surface-2 px-3 py-2 text-[length:var(--step--1)] text-ink focus:border-focus" />
        {hydrated && (
          <button type="button" onClick={copy} aria-live="polite"
            className="ui min-h-12 shrink-0 cursor-pointer rounded-[var(--radius)] border-2 border-rule bg-surface px-3 text-[length:var(--step--1)] font-semibold text-ink hover:border-rule-strong">
            {copied ? copiedLabel : copyLabel}
          </button>
        )}
      </div>
    </div>
  );
}
