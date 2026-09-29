import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getStoryFull, getThreadStories, getGlossaryMap, getSitePrefs, getWithdrawnStory, type WithdrawnStory } from "@/lib/queries";
import { formatDate, formatNumber, formatTime, isLocale, langAttrs, localDigits, pick, picked, slotNames, type Locale, type Slot } from "@/lib/urdu";
import { alternatesFor, dateAt, outletsOf, storyIdFrom } from "@/lib/view";
import { CoverageBadge } from "@/components/coverage-badge";
import { PostCard } from "@/components/post-card";
import { RelativeTime } from "@/components/relative-time";
import { SaveButton } from "@/components/save-button";
import { StoryChips } from "@/components/entity-chips";
import { StoryImage } from "@/components/story-image";
import { storySavedState } from "@/lib/saved";
import { requireUser } from "@/lib/auth";
import { ManualBadge, ManualDisclosure } from "@/components/manual-badge";
import { TranslateButton } from "@/components/translate-button";
import { translateOffers } from "@/lib/translations";
import { FeedbackButtons } from "@/components/feedback-buttons";
import { ReportMistake } from "@/components/report-mistake";
import { myReports, storyVote } from "@/lib/feedback";
import { ReviewLine } from "@/components/review-badge";
import { storyRev } from "@/lib/review-state";
import { reviewLineText } from "@/lib/review-text";

export const revalidate = 3600;
type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const storyId = storyIdFrom(id);
  if (!storyId || !isLocale(locale)) return {};
  const story = await getStoryFull(storyId);
  if (!story) {
    // A withdrawn story (D14) keeps its address, but nothing of its text, not even in the page title.
    if (!(await getWithdrawnStory(storyId))) return {};
    const t = await getTranslations({ locale, namespace: "review" });
    return { title: t("withdrawnTitle"), robots: { index: false, follow: false } };
  }
  return { title: pick(story, "title", locale), description: pick(story, "summary", locale).slice(0, 200), alternates: alternatesFor(`/story/${story.id}`, locale) };
}

export default async function StoryPage({ params }: { params: Params }) {
  const { locale, id } = await params;
  const storyId = storyIdFrom(id);
  if (!isLocale(locale) || !storyId) notFound();
  setRequestLocale(locale);
  // The page's own check behind the proxy's and the layout's (a client-side navigation skips the layout).
  await requireUser({ locale, next: `/${locale}/story/${storyId}` });
  const story = await getStoryFull(storyId);
  if (!story) {
    const withdrawn = await getWithdrawnStory(storyId);
    if (!withdrawn) notFound();
    return <Withdrawn w={withdrawn} locale={locale as Locale} />;
  }
  const l = locale as Locale;
  const [t, prefs, threadStories, labels] = await Promise.all([getTranslations(), getSitePrefs(), story.threadId ? getThreadStories(story.threadId) : Promise.resolve([]), locale === "ur" ? getGlossaryMap() : Promise.resolve(new Map<string, string>())]);
  const outletName = (name: string) => labels.get(name.toLowerCase()) ?? name;
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  const num = (s: string) => localDigits(s, l, digits);
  const outlets = outletsOf(story);
  const itemById = new Map(story.sources.map((s) => [s.item.id, s.item]));
  const ed = story.edition;
  const other = l === "ur" ? "en" : "ur";
  const hasOther = l === "ur" ? !!story.titleEn : !!story.titleUr;
  const title = picked(story, "title", l), summary = picked(story, "summary", l), why = picked(story, "why", l), contested = picked(story, "contested", l);
  const threadTitle = story.thread ? picked(story.thread, "title", l) : null;
  const saved = await storySavedState(story.id);
  // A manual story live on the Editor's desk (D12) sits in an unpublished edition: no link to it, and it
  // cannot be saved until that edition is published.
  const onDesk = ed.status !== "published";
  // "Read the full article in Urdu" for cited items that are not in Urdu (D9), by item URL.
  const offers = await translateOffers(story.sources);
  // The reader's own relevance answer and mistake reports on this story (D8); undefined when signed out.
  const [vote, reports] = await Promise.all([storyVote(story.id), myReports(story.id)]);

  return (
    // data-tb-rev: what the page shows about review, so a kept offline copy is refreshed when it changes (D14).
    <article className="mx-auto max-w-3xl px-[var(--gutter)] pb-16" data-tb-rev={storyRev(story)}>
      <nav aria-label="Breadcrumb" className="ui meta pt-4">
        {onDesk
          ? <Link href="/#desk">{t("desk.title")}</Link>
          : (
            <Link href={`/${ed.date}/${ed.slot}`}>
              {/* A short date on phones keeps the breadcrumb to one line, even at Wazeh's largest size. Each
                  span holds the whole text: in Wazeh the link is a flex box, which would trim the space before
                  a separate " · ". */}
              <span className="max-sm:hidden">{`${formatDate(dateAt(ed.date), l, { dateStyle: "medium" }, digits)} · ${slotNames[ed.slot as Slot][l]}`}</span>
              <span className="sm:hidden">{`${formatDate(dateAt(ed.date), l, { day: "numeric", month: "short" }, digits)} · ${slotNames[ed.slot as Slot][l]}`}</span>
            </Link>
          )}
        {" / "}
        <Link href={`/section/${story.group.slug}`}>{l === "ur" ? story.group.nameUr : story.group.nameEn}</Link>
      </nav>
      <header className="rule-strong mt-3 pt-4">
        {/* The headline first, then its tags and coverage, so it opens the first screen on a phone. */}
        <h1 className="display text-[length:var(--step-3)]" {...langAttrs(title.lang, l)}>{title.text}</h1>
        <div className="story-tags mt-3 flex flex-wrap items-center gap-2">
          {story.tag === "must-read" && <span className="pill pill-accent">{t("tags.must-read")}</span>}
          {story.thread && <span className="pill pill-soft">{t("story.thread")}</span>}
          <ManualBadge story={story} shown={title.lang} />
          <CoverageBadge coverage={story.coverage} outletCount={outlets.length} />
          <span className="meta">{num(t("story.sources", { count: outlets.length }))}</span>
        </div>
        {/* D14: whether an editor has reviewed it, and the automatic check's note when it raised a question. */}
        <ReviewLine story={story} locale={l} digits={digits} className="mt-3" />
        {/* The publisher's photo, under the headline, with its credit (D6). */}
        <StoryImage story={story} locale={l} variant="hero" priority />
        {hasOther && (
          // A plain link: switching language loads a new document (see components/locale-switch.tsx).
          <p className="ui mt-3"><a href={`/${other}/story/${story.id}`} lang={other} hrefLang={other} dir={other === "ur" ? "rtl" : "ltr"} className="chip">{other === "ur" ? t("story.readInUrdu") : t("story.readInEnglish")}</a></p>
        )}
        {saved !== null && !onDesk && <p className="ui no-print mt-3"><SaveButton kind="story" id={story.id} saved={saved} label={t("saved.saveStory")} /></p>}
        {onDesk && <p className="meta mt-3">{t("desk.notInEdition")}</p>}
      </header>

      <section className="mt-6" aria-labelledby="wwk">
        <h2 id="wwk" className="ui text-[length:var(--step--1)] font-semibold uppercase tracking-wide text-accent">{t("story.whatWeKnow")}</h2>
        <p className="prose measure mt-2 text-[length:var(--step-1)]" {...langAttrs(summary.lang, l)}>{summary.text}</p>
      </section>
      {why.text && (
        <section className="mt-6" aria-labelledby="why">
          <h2 id="why" className="ui text-[length:var(--step--1)] font-semibold uppercase tracking-wide text-accent">{t("story.whyItMatters")}</h2>
          <p className="prose measure mt-2" {...langAttrs(why.lang, l)}>{why.text}</p>
        </section>
      )}
      {contested.text && (
        <section className="mt-6 card p-4" aria-labelledby="contested">
          <h2 id="contested" className="ui text-[length:var(--step--1)] font-semibold uppercase tracking-wide text-warn">{t("story.contested")}</h2>
          <p className="prose mt-2" {...langAttrs(contested.lang, l)}>{contested.text}</p>
        </section>
      )}
      {story.angles.length > 0 && (
        <section className="mt-6" aria-labelledby="angles">
          <h2 id="angles" className="ui text-[length:var(--step--1)] font-semibold uppercase tracking-wide text-accent">{t("story.angles")}</h2>
          <ul className="mt-2 divide-y divide-rule">
            {story.angles.map((a, i) => {
              const item = itemById.get(a.itemId);
              const note = picked(a, "note", l);
              return (
                <li key={i} className="py-2">
                  <span className={labels.has((item?.source.name ?? "").toLowerCase()) ? "font-semibold" : "latin font-semibold"}>{item ? outletName(item.source.name) : "—"}</span>
                  {item?.source.perspective && <span className="meta latin"> · {item.source.perspective}</span>}
                  <p className="mt-1" {...langAttrs(note.lang, l)}>{note.text}</p>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <StoryChips story={story} locale={l} detailed />

      <section className="mt-8" aria-labelledby="sources">
        <h2 id="sources" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{num(t("story.sources", { count: outlets.length }))}</h2>
        <ul className="mt-2 divide-y divide-rule">
          {outlets.map((o) => (
            <li key={o.name} className="py-3">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className={labels.has(o.name.toLowerCase()) ? "font-semibold" : "latin font-semibold"}>{outletName(o.name)}</span>
                {o.isPrimary && <span className="pill pill-soft">{formatNumber(1, l, digits)}</span>}
                {o.perspective && <span className="meta latin">{o.perspective}</span>}
              </div>
              <p className="mt-1">
                <span className="meta">{t("story.originalHeadline")}: </span>
                <a href={o.url} target="_blank" rel="noopener noreferrer" {...langAttrs(o.lang === "ur" ? "ur" : "en", l)}>{o.title}</a>
              </p>
              {o.publishedAt && (
                <p className="meta mt-1">
                  {formatDate(o.publishedAt, l, { dateStyle: "medium" }, digits)} · {formatTime(o.publishedAt, l, digits)}
                  <RelativeTime iso={o.publishedAt.toISOString()} locale={l} digits={digits} absolute={false} prefix=" · " />
                </p>
              )}
              {offers.has(o.url) && <div className="no-print mt-2"><TranslateButton offer={offers.get(o.url)!} storyId={story.id} /></div>}
            </li>
          ))}
        </ul>
      </section>

      {story.posts.length > 0 && (
        <section className="mt-8" aria-labelledby="posts">
          <h2 id="posts" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("story.posts")}</h2>
          <div className="mt-3 grid gap-3">
            {story.posts.map((p) => <PostCard key={p.post.id} post={p.post} locale={l} />)}
          </div>
        </section>
      )}

      {threadStories.length > 1 && threadTitle && (
        <section className="mt-8" aria-labelledby="thread">
          <h2 id="thread" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("story.thread")}: <span {...langAttrs(threadTitle.lang, l)}>{threadTitle.text}</span></h2>
          <p className="meta mt-1">{t("story.appearedIn")}:</p>
          <ul className="ui mt-1 flex flex-wrap gap-2">
            {threadStories.map((s) => (
              <li key={s.id}>
                <Link href={`/story/${s.id}`} aria-current={s.id === story.id ? "page" : undefined} className={`chip ${s.id === story.id ? "!border-rule-strong" : ""}`}>
                  {formatDate(dateAt(s.edition.date), l, { dateStyle: "medium" }, digits)} · {slotNames[s.edition.slot as Slot][l]}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {story.corrections.length > 0 && (
        <section className="mt-8" aria-labelledby="corr">
          <h2 id="corr" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("story.corrections")}</h2>
          <ul className="mt-2 divide-y divide-rule">
            {story.corrections.map((c) => {
              const text = picked(c, "text", l);
              return <li key={c.id} className="py-2"><span className="meta">{formatDate(c.createdAt, l, { dateStyle: "medium" }, digits)}</span> · <span {...langAttrs(text.lang, l)}>{text.text}</span></li>;
            })}
          </ul>
        </section>
      )}

      {vote !== undefined && (
        // Relevance feedback and "Report a mistake" (D8): the reader's own, private answers.
        <section className="no-print rule-top mt-10 pt-4" aria-labelledby="fb">
          <h2 id="fb" className="ui text-[length:var(--step-0)] font-semibold">{t("feedback.question")}</h2>
          <FeedbackButtons storyId={story.id} vote={vote} variant="page" className="mt-3" />
          <h2 className="ui mt-6 text-[length:var(--step-0)] font-semibold">{t("report.heading")}</h2>
          <div className="mt-2"><ReportMistake storyId={story.id} previous={reports} /></div>
        </section>
      )}

      {story.origin === "manual"
        // An editor's story has its own disclosure (D12): written by an editor, not AI, never AI-checked.
        ? <ManualDisclosure story={story} className="meta measure mt-10" />
        // Each AI story its own (D14): written by AI from its sources, and whether an editor has reviewed it.
        : <p className="meta measure mt-10" data-story-disclosure="">{num([
            t("review.aiWritten", { count: outlets.length }), reviewLineText(t, story, l, digits), t("review.everyClaim"),
          ].join(l === "ur" ? "۔ " : ". "))}</p>}
    </article>
  );
}

/** A story the editors withdrew (D14): that it was withdrawn, when and why; never its text. */
async function Withdrawn({ w, locale: l }: { w: WithdrawnStory; locale: Locale }) {
  const [t, prefs] = await Promise.all([getTranslations("review"), getSitePrefs()]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  const mine = (l === "ur" ? w.noteUr : w.noteEn).trim();
  const other = (l === "ur" ? w.noteEn : w.noteUr).trim();
  const note = mine ? { text: mine, lang: l } : other ? { text: other, lang: l === "ur" ? "en" as const : "ur" as const } : null;
  return (
    <article className="mx-auto max-w-3xl px-[var(--gutter)] pb-16" data-tb-rev="w" aria-labelledby="withdrawn">
      <header className="rule-strong mt-6 pt-4">
        <h1 id="withdrawn" className="display text-[length:var(--step-3)]">{t("withdrawnTitle")}</h1>
        <p className="meta mt-3">{localDigits(t("withdrawnOn", { date: `${formatDate(w.withdrawnAt, l, { dateStyle: "long" }, digits)}${l === "ur" ? "،" : ","} ${formatTime(w.withdrawnAt, l, digits)}` }), l, digits)}</p>
      </header>
      {note && (
        <section className="card mt-6 p-4" aria-labelledby="wnote">
          <h2 id="wnote" className="ui font-semibold">{t("withdrawnNote")}</h2>
          <p className="prose mt-2" {...langAttrs(note.lang, l)}>{note.text}</p>
        </section>
      )}
      <p className="measure mt-6 text-ink-2">{t("withdrawnText")}</p>
      <p className="ui mt-6"><Link href="/" className="chip">{t("withdrawnBack")}</Link></p>
    </article>
  );
}
