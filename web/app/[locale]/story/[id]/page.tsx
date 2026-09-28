import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getStoryFull, getThreadStories, getGlossaryMap, getSitePrefs } from "@/lib/queries";
import { formatDate, formatNumber, formatTime, isLocale, langAttrs, localDigits, pick, picked, slotNames, type Locale, type Slot } from "@/lib/urdu";
import { alternatesFor, dateAt, outletsOf, storyIdFrom } from "@/lib/view";
import { CoverageBadge } from "@/components/coverage-badge";
import { PostCard } from "@/components/post-card";
import { RelativeTime } from "@/components/relative-time";
import { disclosureText } from "@/components/site-footer";
import { SaveButton } from "@/components/save-button";
import { StoryChips } from "@/components/entity-chips";
import { StoryImage } from "@/components/story-image";
import { storySavedState } from "@/lib/saved";
import { requireUser } from "@/lib/auth";

export const revalidate = 3600;
type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const storyId = storyIdFrom(id);
  const story = storyId ? await getStoryFull(storyId) : null;
  if (!story || !isLocale(locale)) return {};
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
  if (!story) notFound();
  const l = locale as Locale;
  const [t, prefs, disclosure, threadStories, labels] = await Promise.all([getTranslations(), getSitePrefs(), disclosureText(l), story.threadId ? getThreadStories(story.threadId) : Promise.resolve([]), locale === "ur" ? getGlossaryMap() : Promise.resolve(new Map<string, string>())]);
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

  return (
    <article className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <nav aria-label="Breadcrumb" className="ui meta pt-4">
        <Link href={`/${ed.date}/${ed.slot}`}>{formatDate(dateAt(ed.date), l, { dateStyle: "medium" }, digits)} · {slotNames[ed.slot as Slot][l]}</Link>
        {" / "}
        <Link href={`/section/${story.group.slug}`}>{l === "ur" ? story.group.nameUr : story.group.nameEn}</Link>
      </nav>
      <header className="rule-strong mt-3 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          {story.tag === "must-read" && <span className="pill pill-accent">{t("tags.must-read")}</span>}
          {story.thread && <span className="pill pill-soft">{t("story.thread")}</span>}
          {story.qaStatus === "flagged" && <span className="pill pill-soft">{t("qa.flagged")}</span>}
          <CoverageBadge coverage={story.coverage} outletCount={outlets.length} />
          <span className="meta">{num(t("story.sources", { count: outlets.length }))}</span>
        </div>
        <h1 className="display mt-3 text-[length:var(--step-3)]" {...langAttrs(title.lang, l)}>{title.text}</h1>
        {/* The publisher's photo, under the headline, with its credit (D6). */}
        <StoryImage story={story} locale={l} variant="hero" priority />
        {hasOther && (
          // A plain link: switching language loads a new document (see components/locale-switch.tsx).
          <p className="ui mt-3"><a href={`/${other}/story/${story.id}`} lang={other} hrefLang={other} dir={other === "ur" ? "rtl" : "ltr"} className="chip">{other === "ur" ? t("story.readInUrdu") : t("story.readInEnglish")}</a></p>
        )}
        {saved !== null && <p className="ui no-print mt-3"><SaveButton kind="story" id={story.id} saved={saved} label={t("saved.saveStory")} /></p>}
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

      <p className="meta measure mt-10">{disclosure}{prefs.editorName ? ` ${t("edition.reviewedBy", { name: prefs.editorName })}.` : ""}</p>
    </article>
  );
}
