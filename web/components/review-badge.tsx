import { getTranslations } from "next-intl/server";
import type { Locale, UrduDigits } from "@/lib/urdu";
import { reviewState, type ReviewFields } from "@/lib/review-state";
import { reviewedWhen } from "@/lib/review-text";

/*
 * Editorial review on the reader site (decision D14 in docs/PLAN.md, lib/review-state.ts). Every edition
 * publishes without waiting for an editor, so each AI-written story says where it stands, calmly and
 * honestly: a compact pill on cards ("Not reviewed yet", "Check raised a question", "Reviewed"), and on the
 * story page the full line ("Not yet reviewed by an editor" / "Reviewed by <name> · <date time>") with the
 * automatic check's note, in plain words, whenever QA flagged the story (never hidden, reviewed or not).
 * An editor's manual entry (D12) shows none of this: its own tag and disclosure say an editor wrote it.
 * lib/review-text.ts has the same wording as plain text for the feeds, the print sheet and the download.
 */

type Story = ReviewFields & { qaNote: string; reviewer?: { name: string } | null };

const PILL = {
  unreviewed: "pill pill-soft",
  flagged: "pill border border-warn bg-surface text-warn",
  reviewed: "pill pill-soft text-ok",
} as const;

/** The pill on a story card; nothing for a manual entry. */
export async function ReviewPill({ story }: { story: ReviewFields }) {
  const state = reviewState(story);
  if (!state) return null;
  const t = await getTranslations("review");
  const label = state === "reviewed" ? t("pillReviewed") : state === "flagged" ? t("pillFlagged") : t("pillUnreviewed");
  const hint = state === "reviewed" ? t("hintReviewed") : state === "flagged" ? t("hintFlagged") : t("hintUnreviewed");
  return (
    <span className={PILL[state]} title={hint} data-review={state}>
      {state === "reviewed" && <span aria-hidden="true">✓ </span>}
      {label}
    </span>
  );
}

/** Latin names keep the Latin face on Urdu pages, isolated from the sentence around them. */
function Name({ children }: { children: React.ReactNode }) {
  const text = typeof children === "string" ? children : Array.isArray(children) ? children.join("") : "";
  return <bdi className={/[؀-ۿ]/.test(text) ? "font-semibold" : "latin font-semibold"}>{children}</bdi>;
}

/** The story page's review line, under its headline, and the automatic check's note for a flagged story. */
export async function ReviewLine({ story, locale, digits, className = "" }: { story: Story; locale: Locale; digits?: UrduDigits; className?: string }) {
  const state = reviewState(story);
  if (!state) return null;
  const t = await getTranslations("review");
  const at = state === "reviewed" ? story.reviewedAt : null;
  const when = at ? reviewedWhen(at, locale, digits) : "";
  const name = story.reviewer?.name.trim();
  const note = story.qaStatus === "flagged" ? story.qaNote.trim() : "";
  return (
    <div className={className} data-review={state}>
      <p className="ui meta flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The line says it all; the pill only marks a question the automatic check raised. */}
        {state === "flagged" && <ReviewPill story={story} />}
        {at && <span aria-hidden="true" className="text-ok">✓</span>}
        <span className={at ? "text-ink" : "text-ink-2"}>
          {at
            ? (name ? t.rich("lineReviewed", { name, when, n: (c) => <Name>{c}</Name> }) : t("lineReviewedNoName", { when }))
            : t("lineUnreviewed")}
        </span>
      </p>
      {story.qaStatus === "flagged" && (
        // The check's own words (English, from the QA pass), never hidden: an honest note, not an alarm.
        <div className={`mt-3 rounded-[var(--radius)] border p-3 ${at ? "border-rule bg-surface-2" : "border-warn bg-surface"}`} role="note">
          <p className="ui font-semibold">{at ? t("checkHadNoted") : t("checkNoted")}</p>
          {/* Its own block in English (lang, direction, line height), also on Urdu pages. */}
          {note && <p className="latin mt-1" lang="en" dir="ltr">{note}</p>}
          <p className="meta mt-1">{at ? t("checkHadNotedHint") : t("checkNotedHint")}</p>
        </div>
      )}
    </div>
  );
}
