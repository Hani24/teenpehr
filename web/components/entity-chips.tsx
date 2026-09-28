import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getEditionEntityChips, knownEventType, type EntityChip } from "@/lib/search";
import { eventTypeLabel } from "@/lib/taxonomy";
import { langAttrs, type Locale } from "@/lib/urdu";
import { TopicChips } from "./topic-chips";

/** The name to show: the Urdu spelling on Urdu pages when there is one, else the English name (marked up as English). */
export function entityName(e: { nameEn: string; nameUr: string }, locale: Locale): { text: string; lang: Locale } {
  return locale === "ur" && e.nameUr ? { text: e.nameUr, lang: "ur" } : { text: e.nameEn, lang: "en" };
}

/** People, places and organisations a story names, as links to their entity pages. */
export function EntityChips({ entities, locale, label, max }: { entities: readonly EntityChip[]; locale: Locale; label: string; max?: number }) {
  const shown = entities.slice(0, max);
  if (!shown.length) return null;
  return (
    <ul className="ui inline-flex flex-wrap items-center gap-1.5" aria-label={label}>
      {shown.map((e) => {
        const name = entityName(e, locale);
        return (
          <li key={e.slug}>
            <Link href={`/entity/${e.slug}`} prefetch={false} className={`chip ${name.lang === "en" ? "latin" : ""}`} {...langAttrs(name.lang, locale)}>{name.text}</Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A story's topics and names, for story cards (`detailed` off: one row, capped) and the story page
 * (`detailed`: labelled rows, with the kind of event). The names come from one query per edition.
 */
export async function StoryChips({ story, locale, maxTopics, maxEntities, detailed = false }: {
  story: { id: number; editionId: number; topics: string[]; eventType?: string | null }; locale: Locale; maxTopics?: number; maxEntities?: number; detailed?: boolean;
}) {
  const [t, te, chips] = await Promise.all([
    getTranslations({ locale, namespace: "topics" }), getTranslations({ locale, namespace: "entities" }), getEditionEntityChips(story.editionId),
  ]);
  const entities = chips.get(story.id) ?? [];
  const eventType = detailed ? knownEventType(story.eventType) : null;
  if (!story.topics.length && !entities.length && !eventType) return null;
  if (!detailed) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <TopicChips topics={story.topics} locale={locale} label={t("inStory")} max={maxTopics} />
        <EntityChips entities={entities} locale={locale} label={te("inStory")} max={maxEntities} />
      </div>
    );
  }
  return (
    <dl className="ui mt-6 grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr] sm:items-baseline">
      {story.topics.length > 0 && <><dt className="meta">{t("inStory")}</dt><dd><TopicChips topics={story.topics} locale={locale} label={t("inStory")} max={maxTopics} /></dd></>}
      {eventType && <><dt className="meta">{t("eventType")}</dt><dd>{eventTypeLabel(eventType, locale)}</dd></>}
      {entities.length > 0 && <><dt className="meta">{te("inStory")}</dt><dd><EntityChips entities={entities} locale={locale} label={te("inStory")} max={maxEntities} /></dd></>}
    </dl>
  );
}
