import Link from "next/link";

/*
 * Small pieces shared by the D8–D12 admin screens (manual stories, feedback, reports, translations, jobs).
 * No server-only imports, so the client form can use them too. Choices are native radio buttons and
 * checkboxes shown as chips (no pull-down menus: easier to read and to hit, in any palette or direction).
 */

/** Filter links as chips; the current one is marked for assistive tech (aria-current) and visibly. */
export function ChipNav({ label, items }: { label: string; items: Array<{ href: string; label: React.ReactNode; current: boolean; count?: number }> }) {
  return (
    <nav aria-label={label} className="mb-4 flex flex-wrap items-center gap-2">
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={i.current ? "page" : undefined}
          className={`chip min-h-11 px-3 font-semibold ${i.current ? "!border-ink !bg-ink !text-paper" : ""}`}>
          {i.label}{i.count != null && <span className="tabular-nums opacity-80">{i.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export type Choice = { value: string; label: React.ReactNode; hint?: React.ReactNode; disabled?: boolean };

/** A labelled group of radio buttons (or checkboxes with `multiple`), each a large chip. */
export function ChoiceGroup({ legend, name, choices, defaultValue, defaultValues, multiple = false, required = false, hint, onChange, value, className = "" }: {
  legend: React.ReactNode; name: string; choices: Choice[]; defaultValue?: string; defaultValues?: string[]; multiple?: boolean; required?: boolean;
  hint?: React.ReactNode; onChange?: (value: string, checked: boolean) => void; value?: string; className?: string;
}) {
  return (
    <fieldset className={`min-w-0 ${className}`}>
      <legend className="mb-1 text-sm font-semibold">{legend}</legend>
      {hint && <p className="meta mb-2">{hint}</p>}
      <div className="flex flex-wrap gap-2">
        {choices.map((c) => {
          const controlled = value !== undefined && !multiple;
          return (
            <label key={c.value}
              className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm has-[:checked]:border-ink has-[:checked]:bg-surface-2 has-[:checked]:font-semibold has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus ${c.disabled ? "cursor-not-allowed opacity-50" : ""}`}>
              <input type={multiple ? "checkbox" : "radio"} name={name} value={c.value} disabled={c.disabled} required={required && !multiple}
                {...(controlled ? { checked: value === c.value } : { defaultChecked: multiple ? defaultValues?.includes(c.value) : defaultValue === c.value })}
                onChange={onChange ? (e) => onChange(c.value, e.currentTarget.checked) : undefined}
                className="h-4 w-4 shrink-0 accent-[var(--ink)]" />
              <span>
                {c.label}
                {c.hint && <span className="meta block font-normal">{c.hint}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const JOB_TONE: Record<string, string> = {
  queued: "pill-soft", running: "pill-soft text-warn", done: "pill-soft text-ok", failed: "pill-accent", blocked: "pill-soft text-accent",
};
/** A job's or translation's status. */
export function JobPill({ status, title }: { status: string; title?: string }) {
  return <span className={`pill ${JOB_TONE[status] ?? "pill-soft"}`} title={title}>{status}</span>;
}

const STATE: Record<string, { label: string; tone: string; title: string }> = {
  published: { label: "published", tone: "pill-soft text-ok", title: "Out with a published edition. Immutable: corrections only." },
  desk: { label: "live on the desk", tone: "pill-accent", title: "Live on the front page's Editor's desk; joins the next edition that publishes. Immutable: corrections only." },
  scheduled: { label: "scheduled", tone: "pill-soft", title: "Ready; goes out when its edition publishes." },
  waiting: { label: "waiting", tone: "pill-soft text-warn", title: "Not ready: a language or a worker job is outstanding (or a ready desk story waits to go live)." },
};
export function StatePill({ state }: { state: string }) {
  const s = STATE[state] ?? { label: state, tone: "pill-soft", title: "" };
  return <span className={`pill ${s.tone}`} title={s.title}>{s.label}</span>;
}

/** The tag readers see on a manual story (D12), in both languages. */
export function ManualTag({ name }: { name: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="rounded border border-rule px-2 py-0.5 font-semibold">Manual entry · added by <bdi>{name}</bdi></span>
      <span lang="ur" dir="rtl" className="rounded border border-rule px-2 py-0.5 font-semibold">دستی اندراج · <bdi>{name}</bdi></span>
    </span>
  );
}

/**
 * Text a reader or a publisher wrote, shown as data: direction from its own first strong letter, line breaks
 * kept. `lang` is Urdu only when the text is in Arabic script (a reader using the Urdu site may write English).
 */
export function Quoted({ text }: { text: string }) {
  const urdu = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufefe]/.test(text);
  return <p lang={urdu ? "ur" : "en"} dir="auto" className="whitespace-pre-wrap break-words">{text}</p>;
}

/**
 * Who a reader or editor is, for an admin list: their display name; the email address only for owners (a
 * reader's requests and reports are personal data), otherwise the account number.
 */
export function personLabel(p: { id: number | null; name: string | null; email: string | null }, showEmail: boolean): string | null {
  if (p.id == null) return null;
  return p.name?.trim() || (showEmail && p.email ? p.email : `account #${p.id}`);
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "bad" | "ok" }) {
  return (
    <div className="card p-3">
      <p className="meta">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${tone === "bad" ? "text-accent" : tone === "ok" ? "text-ok" : ""}`}>{value}</p>
      {sub && <p className="meta">{sub}</p>}
    </div>
  );
}
