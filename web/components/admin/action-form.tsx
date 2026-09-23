"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/admin/util";

/** A form whose server action returns a result to show inline (login, test fetch). */
export function ActionForm({ action, children, submitLabel, className = "" }: {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>; children: React.ReactNode; submitLabel: string; className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      <button type="submit" disabled={pending} className="chip mt-2 cursor-pointer font-semibold bg-ink text-paper border-ink disabled:opacity-60">{pending ? "Working…" : submitLabel}</button>
      {state?.error && <p role="alert" className="mt-2 text-sm text-accent">{state.error}</p>}
      {state?.ok && <p role="status" className="mt-2 text-sm text-ok">{state.ok}</p>}
      {state?.result && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          {Object.entries(state.result).map(([k, v]) => <div key={k} className="contents"><dt className="meta">{k}</dt><dd>{String(v)}</dd></div>)}
        </dl>
      )}
    </form>
  );
}
