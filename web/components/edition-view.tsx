import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { EditionFull } from "@/lib/queries";
import { langAttrs, picked, type Locale, type Slot } from "@/lib/urdu";
import { needToKnow, storiesByGroup } from "@/lib/view";
import { editionSavedState } from "@/lib/saved";
import { EditionHeader } from "./edition-header";
import { StoryCard } from "./story-card";
import { DownloadMenu } from "./download-menu";
import { SaveButton } from "./save-button";

type Neighbour = { date: string; slot: string } | null;

/**
 * An edition front page. Groups the admin hides in a theme carry data-hidden-in (see hiddenGroupCss).
 * `desk`: the front page's Editor's desk strip (components/editors-desk.tsx, D12), under the header.
 * Editors' manual stories inside the edition are ordinary cards with their manual-entry tag.
 */
export async function EditionView({ ed, locale, published, prev, next, desk }:
  { ed: EditionFull; locale: Locale; published: Slot[]; prev: Neighbour; next: Neighbour; desk?: React.ReactNode }) {
  const t = await getTranslations();
  const top = needToKnow(ed);
  const byGroup = storiesByGroup(ed);
  const hiddenIn = new Map(ed.groups.map((g) => [g.groupId, g.group.hiddenInThemes]));
  const hiddenAttr = (groupId: number) => (hiddenIn.get(groupId)?.length ? hiddenIn.get(groupId)!.join(" ") : undefined);
  const saved = await editionSavedState(ed.id); // request-cached, the same lookup as the header's; null when signed out
  return (
    <div className="page mx-auto max-w-6xl px-[var(--gutter)]">
      <EditionHeader ed={ed} locale={locale} published={published} prev={prev} next={next} />
      {desk}

      {top.length > 0 && (
        <section aria-labelledby="ntk" className="mt-8">
          <h2 id="ntk" className="ui text-[length:var(--step--1)] font-semibold uppercase tracking-wide text-accent">{t("edition.needToKnow")}</h2>
          <div className="ntk-grid grid gap-x-10 md:grid-cols-2">
            {top.map((s, i) => <StoryCard key={s.id} story={s} locale={locale} lead={i === 0} hiddenIn={hiddenIn.get(s.groupId)} />)}
          </div>
        </section>
      )}

      <div className="edition-grid mt-10 grid gap-x-12 gap-y-10 lg:grid-cols-[1fr_1fr]">
        {ed.groups.map((g) => {
          const stories = (byGroup.get(g.groupId) ?? []).filter((s) => !top.includes(s));
          if (!stories.length && !g.leadEn) return null;
          const lead = picked(g, "lead", locale);
          return (
            <section key={g.id} aria-labelledby={`g-${g.group.slug}`} className="min-w-0" data-hidden-in={hiddenAttr(g.groupId)}>
              <h2 id={`g-${g.group.slug}`} className="rule-strong ui pt-2 text-[length:var(--step-1)] font-bold">
                <Link href={`/section/${g.group.slug}`} className="no-underline hover:underline">{locale === "ur" ? g.group.nameUr : g.group.nameEn}</Link>
              </h2>
              {lead.text && <p className="headline mt-2 text-[length:var(--step-1)] text-ink" {...langAttrs(lead.lang, locale)}>{lead.text}</p>}
              <div className="mt-3">
                {stories.map((s) => <StoryCard key={s.id} story={s} locale={locale} />)}
              </div>
            </section>
          );
        })}
      </div>
      <p className="ui mt-12 text-center text-ink-2">{t("edition.allRead", { slot: t(`slots.${ed.slot}`) })}</p>
      {/* Phones only: save, PDF and download for the whole edition, moved here from the header (EditionHeader). */}
      {saved !== null && (
        <div className="ui no-print mt-4 flex flex-wrap items-center justify-center gap-2 sm:hidden">
          <SaveButton kind="edition" id={ed.id} saved={saved} label={t("saved.saveEdition")} />
          <DownloadMenu date={ed.date} slot={ed.slot} className="justify-center" />
        </div>
      )}
    </div>
  );
}
