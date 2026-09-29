/**
 * Shared code lists for decisions D8–D12 (docs/PLAN.md): the database enums and check constraints in
 * db/schema.ts, the zod contracts (lib/contracts.ts) and the UI all read these, so a list changes in one
 * place. Plain constants with no imports: safe in client components.
 */

/** Source kinds (sources.kind). `manual`: the inactive per-outlet source an editor's link is stored under (D12). */
export const SOURCE_KINDS = ["rss", "html", "gnews", "youtube", "telegram", "manual", "sitemap", "gdelt"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
/** Kinds an editor may pick in the source form; `manual` sources are made by the manual-entry flow only. */
export const EDITABLE_SOURCE_KINDS = ["rss", "html", "gnews", "youtube", "telegram", "sitemap", "gdelt"] as const satisfies readonly SourceKind[];

/**
 * settings.publish_policy (D14 in docs/PLAN.md): what the worker's publish call does with a finished edition.
 * `publish` (the default): publish at once, flagged stories included; every story shows readers whether an
 * editor has reviewed it, and a flagged one shows the automatic check's note until then.
 * `auto`: hold the edition for review (status `review`) when any story is flagged, else publish.
 * `hold`: hold every edition until an editor publishes it in the admin.
 */
export const PUBLISH_POLICIES = ["publish", "auto", "hold"] as const;
export type PublishPolicy = (typeof PUBLISH_POLICIES)[number];
export const DEFAULT_PUBLISH_POLICY: PublishPolicy = "publish";
export function publishPolicyOf(v: unknown): PublishPolicy {
  return typeof v === "string" && (PUBLISH_POLICIES as readonly string[]).includes(v) ? (v as PublishPolicy) : DEFAULT_PUBLISH_POLICY;
}

/** Longest withdrawal note per language (stories.withdraw_note_en / _ur), shown on the story's withdrawn page. */
export const WITHDRAW_NOTE_MAX = 600;

/** stories.qa_status. `manual`: an editor's story (D12), never AI-verified. */
export const QA_STATUSES = ["pending", "verified", "flagged", "manual"] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

/** stories.origin (D12). */
export const STORY_ORIGINS = ["ai", "manual"] as const;
export type StoryOrigin = (typeof STORY_ORIGINS)[number];

/**
 * stories.placement, manual stories only (D12): `edition` goes out with the edition it is in;
 * `desk` goes live on the front page's Editor's desk strip first (stories.desk_at) and joins the next
 * edition that publishes. See lib/desk.ts.
 */
export const MANUAL_PLACEMENTS = ["edition", "desk"] as const;
export type ManualPlacement = (typeof MANUAL_PLACEMENTS)[number];

/** The two story languages; stories.language_filled names the side the worker filled (D12). */
export const STORY_LANGS = ["en", "ur"] as const;
export type StoryLang = (typeof STORY_LANGS)[number];

/** story_feedback.value (D8): 1 "Relevant to me", -1 "Show less like this". */
export const FEEDBACK_VALUES = [1, -1] as const;
export type FeedbackValue = (typeof FEEDBACK_VALUES)[number];
/** Optional reasons on a "Show less like this" vote (D8): topic, outlet, too much of this, not for me. */
export const FEEDBACK_REASONS = ["topic", "outlet", "too_much", "not_for_me"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** story_reports.status (D8 "Report a mistake"). */
export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_TEXT_MAX = 2000;

/** worker_jobs.kind and worker_jobs.status (docs/API.md § Jobs). */
export const JOB_KINDS = ["translate_article", "fill_language", "story_image"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_STATUSES = ["queued", "running", "done", "failed", "blocked"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** article_translations.status (D9). */
export const TRANSLATION_STATUSES = ["queued", "running", "done", "failed", "blocked"] as const;
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];
/**
 * Why the full text could not be had (D9). The reader page turns each into "could not get the full
 * text, here is the link". Never a reason to try harder: no paywall bypass, no evasion.
 */
export const TRANSLATION_BLOCK_REASONS = [
  "paywalled", // subscription wall or metered article
  "robots_disallowed", // robots.txt disallows the article path for our user agent
  "unreachable", // DNS, TLS, timeout, 4xx/5xx after the fetcher's retries
  "needs_germany", // host blocked from Pakistan and the Germany route is down
  "no_text", // the page had no extractable article text (video page, live blog shell, script-only)
  "too_long", // over the worker's length cap
  "not_article", // not a news article (PDF, homepage, a social post)
] as const;
export type TranslationBlockReason = (typeof TRANSLATION_BLOCK_REASONS)[number];

/** x_list_proposals.status (D10): proposals are written by the research step, decided by an owner. */
export const X_LIST_PROPOSAL_STATUSES = ["proposed", "added", "rejected"] as const;
export type XListProposalStatus = (typeof X_LIST_PROPOSAL_STATUSES)[number];
