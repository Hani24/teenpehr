import type { Outlet } from "@/lib/view";

/** Outlet chips. In Urdu, names come from the glossary when available; otherwise the Latin name is isolated. */
export function SourceChips({ outlets, max = 4, labels }: { outlets: Outlet[]; max?: number; labels?: Map<string, string> }) {
  const shown = outlets.slice(0, max);
  const rest = outlets.length - shown.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {shown.map((o) => {
        const ur = labels?.get(o.name.toLowerCase());
        return (
          <a key={o.name} href={o.url} target="_blank" rel="noopener noreferrer" className={`chip ${ur ? "" : "latin"}`} title={o.perspective || o.title}
            lang={ur ? "ur" : "en"} dir={ur ? "rtl" : "ltr"}>
            {ur ?? o.name}
          </a>
        );
      })}
      {rest > 0 && <span className="chip">+{rest}</span>}
    </span>
  );
}
