import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { EditionFull } from "@/lib/queries";
import { pick, type Locale, type Slot } from "@/lib/urdu";
import { needToKnow, storiesByGroup } from "@/lib/view";
import { EditionHeader } from "./edition-header";
import { StoryCard } from "./story-card";

type Neighbour = { date: string; slot: string } | null;

export async function EditionView({ ed, locale, published, prev, next, settings, hiddenGroups = [] }:
  { ed: EditionFull; locale: Locale; published: Slot[]; prev: Neighbour; next: Neighbour; settings: Record<string, unknown>; hiddenGroups?: string[] }) {
  const t = await getTranslations();
  const now = new Date();
  const top = needToKnow(ed);
  const byGroup = storiesByGroup(ed);
  const hidden = new Set(hiddenGroups);
  return (
    <div className="page mx-auto max-w-6xl px-[var(--gutter)]">
      <EditionHeader ed={ed} locale={locale} published={published} prev={prev} next={next}
        editorName={String(settings.editor_name ?? "")} hijriAdjust={Number(settings.hijri_adjust ?? 0)} />

      {top.length > 0 && (
        <section aria-labelledby="ntk" className="mt-8">
          <h2 id="ntk" className="ui text-[length:var(--step--1)] font-semibold uppercase tracking-wide text-accent">{t("edition.needToKnow")}</h2>
          <div className="ntk-grid grid gap-x-10 md:grid-cols-2">
            {top.map((s, i) => <StoryCard key={s.id} story={s} locale={locale} now={now} lead={i === 0} />)}
          </div>
        </section>
      )}

      <div className="edition-grid mt-10 grid gap-x-12 gap-y-10 lg:grid-cols-[1fr_1fr]">
        {ed.groups.filter((g) => !hidden.has(g.group.slug)).map((g) => {
          const stories = (byGroup.get(g.groupId) ?? []).filter((s) => !top.includes(s));
          if (!stories.length && !g.leadEn) return null;
          return (
            <section key={g.id} aria-labelledby={`g-${g.group.slug}`} className="min-w-0">
              <h2 id={`g-${g.group.slug}`} className="rule-strong ui pt-2 text-[length:var(--step-1)] font-bold">
                <Link href={`/section/${g.group.slug}`} className="no-underline hover:underline">{locale === "ur" ? g.group.nameUr : g.group.nameEn}</Link>
              </h2>
              {pick(g, "lead", locale) && <p className="headline mt-2 text-[length:var(--step-1)] text-ink">{pick(g, "lead", locale)}</p>}
              <div className="mt-3">
                {stories.map((s) => <StoryCard key={s.id} story={s} locale={locale} now={now} />)}
              </div>
            </section>
          );
        })}
      </div>
      <p className="ui mt-12 text-center text-ink-2">{t("edition.allRead", { slot: t(`slots.${ed.slot}`) })}</p>
    </div>
  );
}
