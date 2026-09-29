/*
 * Relevance votes as a diverging bar (D8): "Show less like this" grows toward the start from a centre line,
 * "Relevant to me" toward the end, so polarity is carried by position as well as colour. The pair was
 * checked with the dataviz validator on the admin's light surface (lightness, chroma, colour-blind and
 * normal-vision separation, contrast: all pass). Bars are decorative: the numbers sit beside them in the
 * table, which is the accessible view.
 */
export const RELEVANT = "#2a6fb0";
export const LESS = "#b4532a";

export function VoteLegend() {
  return (
    <p className="meta mb-2 flex flex-wrap items-center gap-4" aria-hidden="true">
      <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-s-[4px]" style={{ background: LESS }} />Show less like this</span>
      <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-e-[4px]" style={{ background: RELEVANT }} />Relevant to me</span>
    </p>
  );
}

/** One row's bar: `down` toward the start, `up` toward the end, both scaled to `max`. */
export function VoteBar({ up, down, max }: { up: number; down: number; max: number }) {
  const pct = (v: number) => (max ? Math.max(v ? 3 : 0, (v / max) * 100) : 0);
  return (
    <span className="flex h-3 w-full min-w-24 items-center" aria-hidden="true">
      <span className="flex h-full flex-1 justify-end pe-px">
        <span className="block h-full rounded-s-[4px]" style={{ inlineSize: `${pct(down)}%`, background: LESS }} />
      </span>
      <span className="block h-4 w-px bg-ink-3" />
      <span className="flex h-full flex-1 ps-px">
        <span className="block h-full rounded-e-[4px]" style={{ inlineSize: `${pct(up)}%`, background: RELEVANT }} />
      </span>
    </span>
  );
}

/** A weight in −1…1 as a bar from the centre (a reader's leaning, preview only). */
export function WeightBar({ weight }: { weight: number }) {
  const w = Math.max(-1, Math.min(1, weight));
  return <VoteBar up={w > 0 ? w : 0} down={w < 0 ? -w : 0} max={1} />;
}
