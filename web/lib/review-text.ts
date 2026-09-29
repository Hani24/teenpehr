import type { getTranslations } from "next-intl/server";
import { formatDate, formatTime, localDigits, type Locale, type UrduDigits } from "./urdu";
import { reviewState, type ReviewFields } from "./review-state";

/*
 * The D14 review state as plain text, for the renderers that are not React (the self-contained HTML download,
 * the RSS/JSON feeds) and the print sheet. components/review-badge.tsx is the on-site version; both read the
 * same "review" messages, so the wording never drifts.
 */
type Translator = Awaited<ReturnType<typeof getTranslations<never>>>;
type Story = ReviewFields & { qaNote?: string; reviewer?: { name: string } | null };

const plain = (c: string) => c;

/** When an editor reviewed it, as the pages show it ("29 Sep 2026, 14:05"). */
export function reviewedWhen(at: Date, locale: Locale, digits?: UrduDigits): string {
  // The Urdu comma between date and time on Urdu pages.
  return localDigits(`${formatDate(at, locale, { dateStyle: "medium" }, digits)}${locale === "ur" ? "،" : ","} ${formatTime(at, locale, digits)}`, locale, digits);
}

/** The card pill's words: "Not reviewed yet" / "Check raised a question" / "Reviewed"; "" for a manual entry. */
export function reviewPillText(t: Translator, s: ReviewFields): string {
  const st = reviewState(s);
  return st === "reviewed" ? t("review.pillReviewed") : st === "flagged" ? t("review.pillFlagged") : st === "unreviewed" ? t("review.pillUnreviewed") : "";
}

/** "Reviewed by <name> · <date time>" or "Not yet reviewed by an editor"; "" for a manual entry. */
export function reviewLineText(t: Translator, s: Story, locale: Locale, digits?: UrduDigits): string {
  const st = reviewState(s);
  if (!st) return "";
  if (st !== "reviewed" || !s.reviewedAt) return t("review.lineUnreviewed");
  const when = reviewedWhen(s.reviewedAt, locale, digits);
  const name = s.reviewer?.name.trim();
  return name ? t.markup("review.lineReviewed", { name, when, n: plain }) : t("review.lineReviewedNoName", { when });
}

/** A flagged story's automatic-check note with its label ("An automatic check noted: …"); "" otherwise. */
export function checkNoteText(t: Translator, s: Story): string {
  if (s.origin === "manual" || s.qaStatus !== "flagged") return "";
  const label = s.reviewedAt ? t("review.checkHadNoted") : t("review.checkNoted");
  const note = (s.qaNote ?? "").trim();
  return note ? `${label} ${note}` : label;
}
