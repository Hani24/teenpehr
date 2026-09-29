/*
 * Editorial review state of a story (decision D14 in docs/PLAN.md). Every edition publishes without waiting
 * for an editor; each AI-written story then shows readers whether an editor has reviewed it:
 *
 * - "reviewed": an editor marked it reviewed (stories.reviewed_at, reviewed_by);
 * - "flagged": not reviewed yet, and the automatic QA check raised a question (qa_status "flagged"); the
 *   story page shows the check's note in plain words, never hidden;
 * - "unreviewed": not reviewed yet.
 *
 * An editor's manual entry (D12) has no review state (null): an editor wrote it, and its manual-entry tag and
 * disclosure already say so. A withdrawn story (stories.withdrawn_at) is not shown to readers at all.
 *
 * Plain functions with no imports, shared by the pages, the feeds, the print sheet, the HTML download, the
 * offline manifest and the admin, so every surface reads the same state.
 */

export type ReviewState = "reviewed" | "flagged" | "unreviewed";

export type ReviewFields = {
  origin: string;
  qaStatus: string;
  reviewedAt: Date | null;
  withdrawnAt?: Date | null;
};

/** The story's review state for readers; null for an editor's manual entry (it carries its own tag). */
export function reviewState(s: ReviewFields): ReviewState | null {
  if (s.origin === "manual") return null;
  if (s.reviewedAt) return "reviewed";
  return s.qaStatus === "flagged" ? "flagged" : "unreviewed";
}

/**
 * "N of M stories reviewed" for an edition header: over the stories readers see (not withdrawn) that have a
 * review state (AI-written). `manual` counts the edition's manual entries, so the header can say "AI-written".
 */
export function reviewCounts(stories: ReviewFields[]): { reviewed: number; total: number; flagged: number; manual: number } {
  let reviewed = 0, total = 0, flagged = 0, manual = 0;
  for (const s of stories) {
    if (s.withdrawnAt) continue;
    const st = reviewState(s);
    if (st === null) { manual++; continue; }
    total++;
    if (st === "reviewed") reviewed++;
    else if (st === "flagged") flagged++;
  }
  return { reviewed, total, flagged, manual };
}

/**
 * A short token for what a kept offline copy of a story page shows about its review (public/sw.js compares
 * it with the token on the kept copy and fetches the page again when they differ). Letters, digits, dots.
 */
export function storyRev(s: ReviewFields): string {
  const st = reviewState(s);
  return st === "reviewed" ? `r${s.reviewedAt!.getTime().toString(36)}` : st === "flagged" ? "f" : st === "unreviewed" ? "u" : "m";
}

/** The same for an edition page: how many of its visible stories are reviewed, of how many. */
export function editionRev(stories: ReviewFields[]): string {
  const c = reviewCounts(stories);
  return `e${c.reviewed}.${c.total}.${c.manual}`;
}
