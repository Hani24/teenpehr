/*
 * Building blocks for the sign-in, invite, reset and account pages: large controls (3rem targets,
 * text at --step-0 or more, rem-based so the Wazeh mode scales them), logical properties only, and
 * plain HTML forms that post to /api/auth/* and work without JavaScript.
 */

export function AuthPanel({ title, lead, children, wide = false }: { title: string; lead?: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full ${wide ? "max-w-3xl" : "max-w-[34rem]"} px-[var(--gutter)] pb-16 pt-8`}>
      <h1 className="headline text-[length:var(--step-2)]">{title}</h1>
      {lead && <div className="measure mt-2 text-ink-2">{lead}</div>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

export function Notice({ tone, children }: { tone: "error" | "ok" | "info"; children: React.ReactNode }) {
  const cls = tone === "error" ? "border-accent text-accent" : tone === "ok" ? "border-ok text-ok" : "border-rule text-ink-2";
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`mb-5 rounded-[var(--radius)] border-2 bg-surface px-4 py-3 font-semibold ${cls}`}>
      {children}
    </p>
  );
}

export function TextField({ label, hint, id, ...input }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; id: string }) {
  return (
    <div className="mt-5 first:mt-0">
      <label htmlFor={id} className="ui block font-semibold">{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input}
        className="mt-1.5 min-h-12 w-full rounded-[var(--radius)] border-2 border-rule bg-surface px-3 py-2 text-[length:var(--step-0)] text-ink focus:border-focus read-only:bg-surface-2" />
      {hint && <p id={`${id}-hint`} className="meta mt-1.5">{hint}</p>}
    </div>
  );
}

export function SubmitButton({ children, tone = "primary", full = true }: { children: React.ReactNode; tone?: "primary" | "plain" | "danger"; full?: boolean }) {
  // Colours marked important (!): globals.css sets `button { color: inherit }` outside any layer,
  // which beats Tailwind's utilities layer.
  const cls = tone === "primary" ? "border-accent bg-accent text-accent-ink! hover:opacity-90"
    : tone === "danger" ? "border-accent bg-surface text-accent! hover:bg-surface-2"
    : "border-rule bg-surface text-ink! hover:border-rule-strong";
  return (
    <button type="submit" className={`ui mt-6 min-h-12 cursor-pointer rounded-[var(--radius)] border-2 px-5 py-2 text-[length:var(--step-0)] font-semibold ${full ? "w-full" : ""} ${cls}`}>
      {children}
    </button>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="card mt-6 scroll-mt-24 p-5 sm:p-6">
      <h2 id={`${id}-h`} className="ui text-[length:var(--step-1)] font-bold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
