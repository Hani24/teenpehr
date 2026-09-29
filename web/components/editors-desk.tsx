import { getTranslations } from "next-intl/server";
import { getDeskStories } from "@/lib/queries";
import type { Locale } from "@/lib/urdu";
import { HIDE_IN_MODES } from "@/lib/view";
import { StoryCard } from "./story-card";

/*
 * The Editor's desk strip on the front page (decision D12, lib/desk.ts): editors' manual stories that
 * were published now, ahead of their edition, newest first. Each joins the next edition that is published
 * and then leaves the strip (it is an ordinary story of that edition from then on). Nothing is rendered
 * when the desk is empty. Every card carries the manual-entry tag (components/manual-badge.tsx).
 *
 * Wazeh: one column like the rest of the front page (globals.css turns md:grid-cols-* into one column),
 * and a group the admin hides in Wazeh hides its desk stories there too; when every desk story is hidden
 * in a mode, so is the strip.
 */
export async function EditorsDesk({ locale }: { locale: Locale }) {
  const stories = await getDeskStories();
  if (!stories.length) return null;
  const t = await getTranslations("desk");
  const hiddenEverywhere = HIDE_IN_MODES.filter((m) => stories.every((s) => s.group.hiddenInThemes.includes(m)));
  return (
    <section id="desk" aria-labelledby="desk-h" className="mt-8 rounded-[var(--radius)] border-2 border-rule-strong bg-surface px-4 pt-3 md:px-6"
      data-hidden-in={hiddenEverywhere.length ? hiddenEverywhere.join(" ") : undefined}>
      <h2 id="desk-h" className="ui text-[length:var(--step--1)] font-semibold uppercase tracking-wide text-accent">{t("title")}</h2>
      <p className="meta measure mt-1">{t("intro")}</p>
      <div className="grid gap-x-10 md:grid-cols-2">
        {stories.map((s) => (
          <StoryCard key={s.id} story={s} locale={locale} desk hiddenIn={s.group.hiddenInThemes.length ? s.group.hiddenInThemes : undefined} />
        ))}
      </div>
    </section>
  );
}
