"use client";
import { useActionState } from "react";
import { CopyField } from "@/components/copy-field";
import type { LinkState } from "./actions";

/**
 * A form whose action makes an invite or reset link, then shows it once: the link with Copy, a
 * WhatsApp share (wa.me opens the app or web with the message ready; the owner picks the chat), and
 * the message text. Works without JavaScript too (the page re-renders with the result).
 */
export function LinkForm({ action, children, submitLabel, className = "" }: {
  action: (state: LinkState, fd: FormData) => Promise<LinkState>; children?: React.ReactNode; submitLabel: string; className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <div className={className}>
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        {children}
        <button type="submit" disabled={pending} className="chip min-h-10 cursor-pointer border-ink! bg-ink! font-semibold text-paper! disabled:opacity-60">
          {pending ? "Working…" : submitLabel}
        </button>
      </form>
      {state && !state.ok && <p role="alert" className="mt-2 text-sm font-semibold text-accent">{state.error}</p>}
      {state?.ok && (
        <div role="status" className="mt-3 rounded border-2 border-ok bg-surface p-3 text-sm">
          <p className="font-semibold text-ok">
            {state.kind === "invite" ? "Invite" : "Reset link"} for <bdi>{state.email}</bdi>, single use, until {state.until}. It is shown only now.
          </p>
          <CopyField label="Link" value={state.url} copyLabel="Copy" copiedLabel="Copied" />
          <p className="mt-3 flex flex-wrap gap-2">
            <a href={`https://wa.me/?text=${encodeURIComponent(state.message)}`} target="_blank" rel="noopener noreferrer" className="chip font-semibold">Share on WhatsApp ↗</a>
          </p>
          <details className="mt-2">
            <summary className="meta cursor-pointer">Message text</summary>
            <p className="mt-1 whitespace-pre-wrap" dir="auto">{state.message}</p>
          </details>
        </div>
      )}
    </div>
  );
}
