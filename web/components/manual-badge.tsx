import { getTranslations } from "next-intl/server";
import type { Locale } from "@/lib/urdu";

/*
 * Editors' manual stories (decision D12 in docs/PLAN.md): every one is tagged "Manual entry · added by
 * <name>" / "دستی اندراج · <name>" wherever it is shown, and carries its own disclosure (written by an
 * editor, not AI; never AI-checked) instead of the AI one. When the worker wrote one language from the
 * editor's text (stories.language_filled), that side is marked as an AI translation of the editor's text.
 * The name is the byline snapshot (stories.created_by_name), so it never changes after publication.
 */

type ManualFields = { origin: string; createdByName: string; languageFilled: string | null };

const ARABIC_SCRIPT = /[؀-ۿ]/;

/** The editor's name, isolated from the sentence around it; a Latin name keeps the Latin face on Urdu pages. */
function EditorName({ children }: { children: React.ReactNode }) {
  const text = typeof children === "string" ? children : Array.isArray(children) ? children.join("") : "";
  return <bdi className={ARABIC_SCRIPT.test(text) ? undefined : "latin"}>{children}</bdi>;
}

/**
 * The tag on a card or a story page, nothing for the worker's stories. With `shown` (the language the
 * reader sees the story in), a second tag marks that side when it is the worker's translation of the
 * editor's text.
 */
export async function ManualBadge({ story, shown }: { story: ManualFields; shown?: Locale }) {
  if (story.origin !== "manual") return null;
  const t = await getTranslations("manual");
  const name = story.createdByName.trim();
  return (
    <>
      <span className="pill border border-rule-strong bg-surface text-ink" data-manual="">
        {name ? t.rich("badge", { name, n: (c) => <EditorName>{c}</EditorName> }) : t("badgeNoName")}
      </span>
      {shown && story.languageFilled === shown && (
        <span className="pill pill-soft">{t(shown === "ur" ? "filledShortUr" : "filledShortEn")}</span>
      )}
    </>
  );
}

/** The disclosure line under a manual story (in place of the AI disclosure), with the filled side named. */
export async function ManualDisclosure({ story, className }: { story: ManualFields; className?: string }) {
  if (story.origin !== "manual") return null;
  const t = await getTranslations("manual");
  const name = story.createdByName.trim();
  return (
    <p className={className}>
      {name ? t.rich("disclosure", { name, n: (c) => <EditorName>{c}</EditorName> }) : t("disclosureNoName")}
      {story.languageFilled === "ur" && <> {t("filledUr")}</>}
      {story.languageFilled === "en" && <> {t("filledEn")}</>}
    </p>
  );
}
