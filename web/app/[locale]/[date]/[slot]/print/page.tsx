import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireUser } from "@/lib/auth";
import { getEditionFull, getGlossaryMap, getSitePrefs, type StoryFull } from "@/lib/queries";
import { urduFaces } from "@/lib/fonts";
import { isEditionDate, safeHref, sourcesByOutlet } from "@/lib/offline-html";
import { dateAt, distinctSourceCount, outletsOf, storiesByGroup } from "@/lib/view";
import { formatDate, formatHijri, formatTime, isLocale, langAttrs, localDigits, picked, SLOTS, type Locale, type Slot, type UrduDigits } from "@/lib/urdu";
import { disclosureText } from "@/components/site-footer";
import { StoryImage } from "@/components/story-image";
import { PrintButton } from "./print-button";
import "@/app/print.css";

/*
 * A printable edition (decision D3): one A4 sheet per page, every story with all its sources
 * (headline, outlet, URL, time), the AI disclosure and the date, and a button that opens the
 * print window, where the reader saves it as PDF. Signed-in readers, published editions only.
 * Each story's publisher image (D6) prints beside it with its credit, when the reader's images
 * preference allows; a sensitive one prints only if the reader has opened it here.
 */
type Params = Promise<{ locale: string; date: string; slot: string }>;

function valid(date: string, slot: string): slot is Slot {
  return isEditionDate(date) && (SLOTS as readonly string[]).includes(slot);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, date, slot } = await params;
  if (!isLocale(locale) || !valid(date, slot)) return {};
  const t = await getTranslations({ locale });
  return {
    title: t("download.printTitle", { edition: t(`slots.${slot}Long`), date: formatDate(dateAt(date), locale, { dateStyle: "long" }) }),
    robots: { index: false, follow: false },
  };
}

/* The headline Nastaliq again, under its own name with font-display: block: the site's face is
   "optional", which may never swap in on this page, and a sheet must print in the face it shows. */
const printNastaliqCss = `@font-face{font-family:"Tabayyun Print Nastaliq";src:url("${urduFaces.nastaliq.href}") format("woff2");font-weight:${urduFaces.nastaliq.weight};font-style:normal;font-display:block;unicode-range:U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFC,U+200C-200F}`;

export default async function PrintPage({ params }: { params: Params }) {
  const { locale, date, slot } = await params;
  if (!isLocale(locale) || !valid(date, slot)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  await requireUser({ locale: l, next: `/${l}/${date}/${slot}/print` });
  const ed = await getEditionFull(date, slot);
  if (!ed) notFound();
  const [t, prefs, disclosure, labels] = await Promise.all([
    getTranslations(), getSitePrefs(), disclosureText(l), l === "ur" ? getGlossaryMap() : Promise.resolve(new Map<string, string>()),
  ]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  const num = (s: string) => localDigits(s, l, digits);
  const day = dateAt(ed.date);
  const byGroup = storiesByGroup(ed);
  const groups = ed.groups.filter((g) => (byGroup.get(g.groupId)?.length ?? 0) > 0 || g.leadEn);
  const now = new Date();
  const site = (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const online = `${site}/${l}/${ed.date}/${ed.slot}`;
  const reviewed = prefs.editorName ? t("edition.reviewedBy", { name: prefs.editorName }) : "";

  return (
    <div className="print-doc mx-auto max-w-4xl px-[var(--gutter)] pb-16">
      <style dangerouslySetInnerHTML={{ __html: printNastaliqCss }} />
      <div className="print-toolbar card no-print ui">
        <PrintButton urdu={l === "ur"} />
        <p className="meta">{t.rich("download.printHint", { ltr: (c) => <bdi lang="en" dir="ltr" className="latin font-semibold">{c}</bdi> })}</p>
        {/* TARGET's sizes (components/save-button.tsx), written out: a client module's constant is not a string here. */}
        <a href={`/${l}/${ed.date}/${ed.slot}`} className="chip !min-h-11 wazeh:!min-h-[max(48px,2.4em)] wazeh:!min-w-12">{t("download.backToEdition")}</a>
      </div>

      <article className="print-sheet" aria-labelledby="print-title">
        <header className="print-mast">
          <p className="print-site">{t("site.name")}</p>
          <p className="print-meta">{t("site.tagline")}</p>
          <h1 id="print-title" className="print-title">{t(`slots.${ed.slot}Long`)}</h1>
          <p className="print-meta">
            <time dateTime={ed.date}>{formatDate(day, l, { dateStyle: "full" }, digits)}</time>
            {" · "}{formatHijri(day, l, prefs.hijriAdjust, digits)} ({t("time.hijriApprox")})
          </p>
          <p className="print-meta">
            {ed.publishedAt && num(t("edition.compiledAt", { time: formatTime(ed.publishedAt, l, digits), count: distinctSourceCount(ed) }))}
            {reviewed && <> · {reviewed}</>}
          </p>
        </header>

        {groups.map((g) => {
          const lead = picked(g, "lead", l);
          return (
            <section key={g.id} className="print-group" aria-labelledby={`pg-${g.group.slug}`}>
              <h2 id={`pg-${g.group.slug}`}>{l === "ur" ? g.group.nameUr : g.group.nameEn}</h2>
              {lead.text && <p className="print-lead" {...langAttrs(lead.lang, l)}>{lead.text}</p>}
              {(byGroup.get(g.groupId) ?? []).map((s) => <PrintStory key={s.id} story={s} locale={l} digits={digits} labels={labels} t={t} />)}
            </section>
          );
        })}

        <footer className="print-colophon">
          <p>{disclosure}{reviewed ? ` ${reviewed}.` : ""}</p>
          <p>{t("download.printedOn", { date: `${formatDate(now, l, { dateStyle: "long" }, digits)} · ${formatTime(now, l, digits)}` })}</p>
          <p>{t("download.onlineAt")} <span className="print-url" lang="en" dir="ltr">{online}</span></p>
        </footer>
      </article>
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<never>>>;

/** An outlet's name: the glossary's Urdu name on Urdu pages when there is one, else the Latin name, isolated. */
function Outlet({ name, labels }: { name: string; labels: Map<string, string> }) {
  const ur = labels.get(name.toLowerCase());
  return ur ? <b>{ur}</b> : <b className="latin" lang="en" dir="ltr">{name}</b>;
}

function PrintStory({ story: s, locale: l, digits, labels, t }: { story: StoryFull; locale: Locale; digits?: UrduDigits; labels: Map<string, string>; t: T }) {
  const num = (x: string) => localDigits(x, l, digits);
  const outlets = outletsOf(s);
  const itemById = new Map(s.sources.map((x) => [x.item.id, x.item]));
  const title = picked(s, "title", l), summary = picked(s, "summary", l), why = picked(s, "why", l), contested = picked(s, "contested", l);
  const cov = s.coverage ?? (outlets.length > 1 ? "broad" : "single-source");
  return (
    <article className="print-story" aria-labelledby={`ps-${s.id}`}>
      <p className="print-tags">
        {s.tag === "must-read" && <><span className="print-pill">{t("tags.must-read")}</span> · </>}
        {s.thread && <>{t("story.thread")} · </>}
        {s.qaStatus === "flagged" && <>{t("qa.flagged")} · </>}
        {t(`coverage.${cov}`)} · {num(t("story.sources", { count: outlets.length }))}
      </p>
      <h3 id={`ps-${s.id}`} {...langAttrs(title.lang, l)}>{title.text}</h3>
      <StoryImage story={s} locale={l} variant="print" />
      <p {...langAttrs(summary.lang, l)}>{summary.text}</p>
      {why.text && <p><b>{t("story.whyItMatters")}:</b> <span {...langAttrs(why.lang, l)}>{why.text}</span></p>}
      {contested.text && (
        <div className="print-contested">
          <h4>{t("story.contested")}</h4>
          <p {...langAttrs(contested.lang, l)}>{contested.text}</p>
        </div>
      )}
      {s.angles.length > 0 && (
        <>
          <h4>{t("story.angles")}</h4>
          <ul className="print-list">
            {s.angles.map((a, i) => {
              const item = itemById.get(a.itemId);
              const note = picked(a, "note", l);
              return <li key={i}>{item ? <Outlet name={item.source.name} labels={labels} /> : "—"}: <span {...langAttrs(note.lang, l)}>{note.text}</span></li>;
            })}
          </ul>
        </>
      )}
      <h4>{num(t("story.sources", { count: outlets.length }))}</h4>
      <ol className="print-list">
        {/* Every cited headline, under its outlet (the site shows one per outlet; this is the record). */}
        {sourcesByOutlet(s).map((o) => (
          <li key={o.name}>
            <Outlet name={o.name} labels={labels} />
            {/* The separator outside the isolated English run, so it sits beside the outlet's name in Urdu too. */}
            {o.perspective && <><span className="print-small"> · </span><span className="print-small latin" lang="en" dir="ltr">{o.perspective}</span></>}
            {o.items.map((it) => {
              const href = safeHref(it.url);
              return (
                <span key={it.id} className="print-cite">
                  <br />
                  <span className="print-small">{t("story.originalHeadline")}: </span>
                  <span {...langAttrs(it.lang === "ur" ? "ur" : "en", l)}>{href ? <a href={href}>{it.title}</a> : it.title}</span>
                  {it.publishedAt && <span className="print-small"> · {formatDate(it.publishedAt, l, { dateStyle: "medium" }, digits)}, {formatTime(it.publishedAt, l, digits)}</span>}
                  {href && <><br /><span className="print-url" lang="en" dir="ltr">{href}</span></>}
                </span>
              );
            })}
          </li>
        ))}
      </ol>
      {s.posts.length > 0 && (
        <>
          <h4>{t("story.posts")}</h4>
          {s.posts.map(({ post: p }) => {
            const href = safeHref(p.url);
            return (
              <blockquote key={p.id} className="print-post">
                <p {...langAttrs(/[؀-ۿ]/.test(p.text) ? "ur" : "en", l)}>{p.text}</p>
                <p className="print-small">
                  <bdi>{p.authorName || p.authorHandle}</bdi> <span className="latin" lang="en" dir="ltr">@{p.authorHandle}</span>
                  {" · "}{formatDate(p.postedAt, l, { dateStyle: "medium" }, digits)}, {formatTime(p.postedAt, l, digits)}
                  {href && <><br /><span className="print-url" lang="en" dir="ltr">{href}</span></>}
                </p>
              </blockquote>
            );
          })}
        </>
      )}
      {s.corrections.length > 0 && (
        <>
          <h4>{t("story.corrections")}</h4>
          <ul className="print-list">
            {s.corrections.map((c) => {
              const text = picked(c, "text", l);
              return <li key={c.id}><span className="print-small">{formatDate(c.createdAt, l, { dateStyle: "medium" }, digits)}</span> · <span {...langAttrs(text.lang, l)}>{text.text}</span></li>;
            })}
          </ul>
        </>
      )}
    </article>
  );
}
