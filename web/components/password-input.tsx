"use client";
import { useId, useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * A password field with a "Show password" checkbox under it. The checkbox appears once scripts run;
 * without them this is a plain password input, so the form still works.
 */
export function PasswordInput({ label, hint, showLabel, ...input }: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string; hint?: string; showLabel: string;
}) {
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="mt-5 first:mt-0">
      <label htmlFor={id} className="ui block font-semibold">{label}</label>
      <input
        id={id}
        type={shown ? "text" : "password"}
        dir="auto"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
        className="mt-1.5 min-h-12 w-full rounded-[var(--radius)] border-2 border-rule bg-surface px-3 py-2 text-[length:var(--step-0)] text-ink focus:border-focus"
      />
      {hint && <p id={`${id}-hint`} className="meta mt-1.5">{hint}</p>}
      {hydrated && (
        <label className="ui mt-1 inline-flex min-h-11 cursor-pointer items-center gap-2 text-[length:var(--step--1)] text-ink-2">
          <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} aria-controls={id} className="h-5 w-5 cursor-pointer accent-[var(--accent)]" />
          {showLabel}
        </label>
      )}
    </div>
  );
}
