import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/lib/auth";
import { listSavedEditions, listSavedStories, type SavedEdition, type SavedStory } from "@/lib/saved";
import { getGlossaryMap, getSitePrefs } from "@/lib/queries";
import { formatDate, formatNumber, isLocale, langAttrs, localDigits, picked, type Locale, type UrduDigits } from "@/lib/urdu";
import { dateAt, outletsOf } from "@/lib/view";
import { SaveButton } from "@/components/save-button";
import { DownloadMenu, ShelfDownloadLink } from "@/components/download-menu";
import { SourceChips } from "@/components/source-chips";
import { ManualBadge } from "@/components/manual-badge";
import { ReviewPill } from "@/components/review-badge";

/*
 * The reader's Saved shelf (decision D3): saved editions, then saved stories, newest saved first.
 * Unsaving here leaves the entry in place with its button released, so a mistaken tap is undone by
 * tapping again; the list is re-read on the next visit.
 */
type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "saved" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default async function SavedPage({ params }: { params: Params }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  const user = await requireUser({ locale: l, next: `/${l}/saved` });
  const [editions, stories, t, prefs, labels] = await Promise.all([
    listSavedEditions(user.id), listSavedStories(user.id), getTranslations(), getSitePrefs(),
    l === "ur" ? getGlossaryMap() : Promise.resolve(undefined),
  ]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  const empty = !editions.length && !stories.length;

  return (
    <div className="page mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <header className="rule-strong mt-4 pt-4">
        <h1 className="display text-[length:var(--step-3)]">{t("saved.title")}</h1>
        <p className="measure mt-2 text-ink-2">{t("saved.intro")}</p>
        {!empty && (
          <>
            <p className="meta mt-2">{localDigits(t("saved.counts", { stories: stories.length, editions: editions.length }), l, digits)}</p>
            <div className="ui mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
              <ShelfDownloadLink />
              <span className="meta measure">{t("saved.downloadAllHint")}</span>
            </div>
          </>
        )}
      </header>

      {empty && (
        <section className="card mt-10 p-6 text-center" aria-labelledby="saved-empty">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="3rem" height="3rem" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="mx-auto text-ink-2">
            <path d="M6 3.5h12v17l-6-4.2-6 4.2z" />
          </svg>
          <h2 id="saved-empty" className="headline mt-3 text-[length:var(--step-2)]">{t("saved.emptyTitle")}</h2>
          <p className="measure mx-auto mt-2 text-ink-2">{t("saved.emptyText")}</p>
          <p className="ui mt-6"><Link href="/" className="chip">{t("saved.goToLatest")}</Link></p>
        </section>
      )}

      {editions.length > 0 && (
        <section className="mt-10" aria-labelledby="saved-editions">
          <h2 id="saved-editions" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">
            {t("saved.editions")} <span className="meta font-normal">({formatNumber(editions.length, l, digits)})</span>
          </h2>
          <ul className="mt-2 divide-y divide-rule">
            {editions.map((e) => <EditionRow key={e.id} e={e} locale={l} digits={digits} t={t} />)}
          </ul>
        </section>
      )}

      {stories.length > 0 && (
        <section className="mt-10" aria-labelledby="saved-stories">
          <h2 id="saved-stories" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">
            {t("saved.stories")} <span className="meta font-normal">({formatNumber(stories.length, l, digits)})</span>
          </h2>
          <ul className="mt-2 divide-y divide-rule">
            {stories.map((s) => <StoryRow key={s.story.id} s={s} locale={l} digits={digits} labels={labels} t={t} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<never>>>;

function EditionRow({ e, locale: l, digits, t }: { e: SavedEdition; locale: Locale; digits?: UrduDigits; t: T }) {
  const headingId = `se-${e.id}`;
  return (
    <li className="py-5">
      <h3 id={headingId} className="headline text-[length:var(--step-2)]">
        <Link href={`/${e.date}/${e.slot}`} className="no-underline hover:underline">
          {t(`slots.${e.slot}Long`)} · {formatDate(dateAt(e.date), l, { dateStyle: "long" }, digits)}
        </Link>
      </h3>
      <p className="meta mt-1">
        {localDigits(t("edition.stories", { count: e.storyCount }), l, digits)} · {t("saved.savedOn", { date: formatDate(e.savedAt, l, { dateStyle: "medium" }, digits) })}
      </p>
      {e.leads.length > 0 && (
        <ul className="mt-2 grid gap-1">
          {e.leads.slice(0, 3).map((g) => {
            const lead = picked(g, "lead", l);
            return (
              <li key={g.id} className="text-ink-2">
                <span className="ui font-semibold text-ink">{l === "ur" ? g.group.nameUr : g.group.nameEn}:</span> <span {...langAttrs(lead.lang, l)}>{lead.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="ui mt-3 flex flex-wrap items-center gap-2">
        <SaveButton kind="edition" id={e.id} saved labelledBy={headingId} />
        <DownloadMenu date={e.date} slot={e.slot} />
      </div>
    </li>
  );
}

function StoryRow({ s, locale: l, digits, labels, t }: { s: SavedStory; locale: Locale; digits?: UrduDigits; labels?: Map<string, string>; t: T }) {
  const { story } = s;
  const title = picked(story, "title", l), summary = picked(story, "summary", l);
  const headingId = `ss-${story.id}`;
  return (
    <li className="py-5">
      <p className="meta ui">
        <Link href={`/${story.edition.date}/${story.edition.slot}`}>{t(`slots.${story.edition.slot}Long`)} · {formatDate(dateAt(story.edition.date), l, { dateStyle: "medium" }, digits)}</Link>
        {" · "}{l === "ur" ? story.group.nameUr : story.group.nameEn}
      </p>
      <h3 id={headingId} className="headline mt-1 text-[length:var(--step-2)]" {...langAttrs(title.lang, l)}>
        <Link href={`/story/${story.id}`} className="no-underline hover:underline">{title.text}</Link>
      </h3>
      {story.origin === "manual"
        ? <p className="ui mt-2"><ManualBadge story={story} shown={title.lang} /></p>
        : <p className="ui mt-2"><ReviewPill story={story} /></p>}
      <p className="prose clamp-3 mt-2 text-ink" {...langAttrs(summary.lang, l)}>{summary.text}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <SourceChips outlets={outletsOf(story)} labels={labels} locale={l} digits={digits} />
        <span className="meta">{t("saved.savedOn", { date: formatDate(s.savedAt, l, { dateStyle: "medium" }, digits) })}</span>
        <SaveButton kind="story" id={story.id} saved labelledBy={headingId} className="ms-auto" />
      </div>
    </li>
  );
}
