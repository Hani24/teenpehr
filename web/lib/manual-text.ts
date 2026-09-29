import type { getTranslations } from "next-intl/server";

/*
 * The D12 tag and disclosure of an editor's manual story as plain text, for the renderers that are not
 * React (the offline download, the RSS/JSON feeds) and the print sheet. components/manual-badge.tsx is
 * the on-site version; both read the same "manual" messages, so the wording never drifts.
 */
type Translator = Awaited<ReturnType<typeof getTranslations<never>>>;
type ManualFields = { origin: string; createdByName: string; languageFilled?: string | null };

const plain = (c: string) => c;

/** "Manual entry · added by <name>" / "دستی اندراج · <name>", or "" for the worker's stories. */
export function manualTag(t: Translator, s: ManualFields): string {
  if (s.origin !== "manual") return "";
  const name = s.createdByName.trim();
  return name ? t.markup("manual.badge", { name, n: plain }) : t("manual.badgeNoName");
}

/** The editor's disclosure line (in place of the AI one), with the side the worker filled named; "" for AI stories. */
export function manualDisclosure(t: Translator, s: ManualFields): string {
  if (s.origin !== "manual") return "";
  const name = s.createdByName.trim();
  const base = name ? t.markup("manual.disclosure", { name, n: plain }) : t("manual.disclosureNoName");
  const filled = s.languageFilled === "ur" ? t("manual.filledUr") : s.languageFilled === "en" ? t("manual.filledEn") : "";
  return filled ? `${base} ${filled}` : base;
}
