import Link from "next/link";
import { feedbackBy, feedbackTotals, REASON_LABELS } from "@/lib/admin/feedback-insights";
import { FEEDBACK_REASONS } from "@/lib/codes";
import { Empty } from "@/components/admin/table";
import { VoteBar, VoteLegend } from "./_charts";

const nf = new Intl.NumberFormat("en-GB");

/** Reader feedback (D8) on the Insights page: the last 30 days in one block, with a link to the full view. */
export async function FeedbackSummary({ className = "" }: { className?: string }) {
  const [t, groups] = await Promise.all([feedbackTotals(30), feedbackBy("group", 30)]);
  const max = Math.max(1, ...groups.flatMap((g) => [g.up, g.down]));
  const reasons = FEEDBACK_REASONS.filter((r) => t.reasons[r]).map((r) => `${REASON_LABELS[r].toLowerCase()} ${nf.format(t.reasons[r])}`).join(" · ");
  return (
    <section aria-labelledby="fb-summary" className={className}>
      <h2 id="fb-summary" className="mb-2 mt-8 text-lg font-semibold">Reader feedback, last 30 days</h2>
      <p className="meta mb-2">
        {nf.format(t.up)} &ldquo;relevant to me&rdquo; · {nf.format(t.down)} &ldquo;show less&rdquo;{reasons && <> ({reasons})</>} · {nf.format(t.voters)} readers ·{" "}
        <Link href="/admin/reports">{nf.format(t.reportsOpen)} open mistake report{t.reportsOpen === 1 ? "" : "s"}</Link> · <Link href="/admin/feedback">Full feedback view</Link>
      </p>
      {groups.length === 0 ? <Empty>No votes yet.</Empty> : (
        <div className="card p-3">
          <VoteLegend />
          <ul className="grid gap-1.5 text-sm">
            {groups.map((g) => (
              <li key={g.key} className="grid grid-cols-[minmax(7rem,12rem)_1fr_auto] items-center gap-3">
                <span className="truncate">{g.label}</span>
                <VoteBar up={g.up} down={g.down} max={max} />
                <span className="tabular-nums text-ink-2">{nf.format(g.up)} / {nf.format(g.down)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
