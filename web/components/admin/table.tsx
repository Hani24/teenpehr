export function Table({ children, caption }: { children: React.ReactNode; caption?: string }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}
export function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  // Start-aligned unless the caller aligns it (two text-align utilities on one element would race in the CSS order).
  const align = /\btext-(?:start|end|center|justify)\b/.test(className) ? "" : "text-start";
  return <th scope="col" className={`border-b border-rule bg-surface-2 px-2 py-1.5 font-semibold ${align} ${className}`}>{children}</th>;
}
export function Td({ children, className = "", lang, dir, colSpan }: { children?: React.ReactNode; className?: string; lang?: string; dir?: "rtl" | "ltr"; colSpan?: number }) {
  return <td className={`border-b border-rule px-2 py-1.5 align-top ${className}`} lang={lang} dir={dir} colSpan={colSpan}>{children}</td>;
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="card p-6 text-center text-ink-2">{children}</p>;
}
export function Dot({ tone, title }: { tone: "ok" | "warn" | "bad" | "off"; title: string }) {
  const color = tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : tone === "bad" ? "bg-accent" : "bg-ink-3";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full align-middle ${color}`} title={title} aria-label={title} />;
}
/** Run and edition statuses. `skipped` (slot already published or held) is routine; `empty` and `review` want a look. */
export function StatusPill({ status }: { status: string }) {
  const cls = status === "published" || status === "ok" ? "pill-soft text-ok"
    : status === "failed" ? "pill-accent"
    : status === "empty" || status === "review" ? "pill-soft text-warn"
    : status === "skipped" ? "pill-soft text-ink-3"
    : "pill-soft";
  const title = status === "skipped" ? "The slot was already published or held for review, or changed during the run; nothing was billed after that check." : undefined;
  return <span className={`pill ${cls}`} title={title}>{status}</span>;
}
