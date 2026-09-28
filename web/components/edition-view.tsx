import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { EditionFull } from "@/lib/queries";
import { langAttrs, picked, type Locale, type Slot } from "@/lib/urdu";
import { needToKnow, storiesByGroup } from "@/lib/view";
import { EditionHeader } from "./edition-header";
import { StoryCard } from "./story-card";

type Neighbour = { date: string; slot: string } | null;

/** An edition front page. Groups the admin hides in a theme carry data-hidden-in (see hiddenGroupCss). */
export async function EditionView({ ed, locale, published, prev, next }:
  { ed: EditionFull; locale: Locale; published: Slot[]; prev: Neighbour; next: Neighbour }) {
  const t = await getTranslations();
  const top = needToKnow(ed);
  const byGroup = storiesByGroup(ed);
  const hiddenIn = new Map(ed.groups.map((g) => [g.groupId, g.group.hiddenInThemes]));
  const hiddenAttr = (groupId: number) => (hiddenIn.get(groupId)?.length ? hiddenIn.get(groupId)!.join(" ") : undefined);
  return (
    <div className="page mx-auto max-w-6xl px-[var(--gutter)]">
      <EditionHeader ed={ed} locale={locale} published={published} prev={prev} next={next} />

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
    </div>
  );
}
