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
  return <th scope="col" className={`border-b border-rule bg-surface-2 px-2 py-1.5 text-left font-semibold ${className}`}>{children}</th>;
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
export function StatusPill({ status }: { status: string }) {
  const cls = status === "published" || status === "ok" ? "pill-soft text-ok" : status === "failed" ? "pill-accent" : "pill-soft";
  return <span className={`pill ${cls}`}>{status}</span>;
}
