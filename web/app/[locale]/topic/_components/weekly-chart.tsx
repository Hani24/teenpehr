import type { WeekCount } from "@/lib/search";
import { formatDate, formatNumber, type Locale, type UrduDigits } from "@/lib/urdu";
import { dateAt } from "@/lib/view";

type Labels = { title: string; summary: string; showTable: string; week: string; count: string };

/**
 * Published stories per week as columns (one series, so no legend: the heading names it). No text inside
 * the SVG, so nothing shrinks below the reading size on a phone or in Wazeh: the caption carries the
 * total and the peak, each column has a hover title over its whole slot, and the numbers are in a table.
 * Time runs in the reading direction (oldest at the right on Urdu pages).
 */
export function WeeklyChart({ weeks, locale, digits, labels, id }: { weeks: WeekCount[]; locale: Locale; digits?: UrduDigits; labels: Labels; id: string }) {
  const n = Math.max(1, weeks.length);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const W = 480, H = 132, top = 8, base = H - 2, slot = W / n, barW = Math.min(24, slot - 8);
  const rtl = locale === "ur";
  const day = (w: string) => formatDate(dateAt(w), locale, { day: "numeric", month: "short" }, digits);
  const num = (c: number) => formatNumber(c, locale, digits);
  return (
    <figure className="mt-3" aria-labelledby={`${id}-cap`}>
      <figcaption id={`${id}-cap`} className="meta">{labels.summary}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 block h-auto w-full" role="img" aria-labelledby={`${id}-title ${id}-cap`}>
        <title id={`${id}-title`}>{labels.title}</title>
        <line x1={0} x2={W} y1={base + 1} y2={base + 1} className="stroke-rule" strokeWidth={1} />
        {weeks.map((w, i) => {
          const sx = (rtl ? n - 1 - i : i) * slot, x = sx + (slot - barW) / 2;
          const h = w.count ? Math.max(4, (w.count / max) * (base - top)) : 0, y = base - h, r = Math.min(4, h, barW / 2);
          return (
            <g key={w.week}>
              <title>{`${labels.week} ${day(w.week)}: ${num(w.count)}`}</title>
              <rect x={sx} y={0} width={slot} height={H} fill="transparent" />
              {w.count ? (
                <path d={`M${x} ${base}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + barW - r}Q${x + barW} ${y} ${x + barW} ${y + r}V${base}Z`} className="fill-accent" />
              ) : (
                <rect x={x} y={base - 2} width={barW} height={2} className="fill-rule" />
              )}
            </g>
          );
        })}
      </svg>
      <div className="meta mt-1 flex justify-between" aria-hidden="true">
        <span>{weeks[0] ? day(weeks[0].week) : ""}</span>
        <span>{weeks.at(-1) ? day(weeks.at(-1)!.week) : ""}</span>
      </div>
      <details className="ui mt-2">
        <summary className="cursor-pointer text-ink-2">{labels.showTable}</summary>
        <table className="mt-2 w-full max-w-sm border-collapse text-start">
          <caption className="sr-only">{labels.title}</caption>
          <thead><tr><th scope="col" className="border-b border-rule py-1 text-start">{labels.week}</th><th scope="col" className="border-b border-rule py-1 text-end">{labels.count}</th></tr></thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week}><td className="border-b border-rule py-1"><time dateTime={w.week}>{day(w.week)}</time></td><td className="num border-b border-rule py-1 text-end">{num(w.count)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** The chart caption: total over the period and the busiest week. */
export function weeklySummary(weeks: WeekCount[]): { total: number; peak: WeekCount | null } {
  const total = weeks.reduce((n, w) => n + w.count, 0);
  const peak = total ? weeks.reduce((a, b) => (b.count > a.count ? b : a)) : null;
  return { total, peak };
}
