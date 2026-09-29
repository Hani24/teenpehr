import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/lib/auth";
import { getGlossaryMap, getSitePrefs } from "@/lib/queries";
import { articleForReader, dailyUsage, httpHref, translationPoll, translationRefusal } from "@/lib/translations";
import { formatDate, formatTime, isLocale, langAttrs, localDigits, picked, type Locale } from "@/lib/urdu";
import { storyIdFrom } from "@/lib/view";
import { RequestTranslationForm } from "@/components/translate-button";
import { TranslationLive } from "./live-status";

/*
 * /{locale}/article/{itemId}: the full Urdu translation of an article a story cites (decision D9), on its
 * own page, for signed-in readers only. Labelled "AI translation of <outlet>'s article · may contain
 * errors" with the original's link and date. Before the translation exists the page asks for it, then
 * shows its progress (./live-status.tsx polls). Never in feeds, downloads, search or the X board, and never
 * kept offline (public/sw.js READER_PAGE leaves /article/ out). The rules are in lib/translations.ts.
 *
 * The translated text is plain paragraphs separated by blank lines; a paragraph starting "## " is a
 * subheading. It is rendered as text (never HTML): it came from a fetched page through a model. Its face
 * follows the reader's display choices like any Urdu body text (globals.css: Nastaliq, or Naskh in Wazeh
 * unless the reader switched Nastaliq on).
 */

// Per reader and per moment (the translation's progress): never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "translation" });
  return { title: t("pageTitle"), robots: { index: false, follow: false } };
}

type Block = { kind: "p" | "h"; text: string } | { kind: "ul"; items: string[] };
/**
 * Paragraphs (blank-line separated, or one per line when there are no blank lines), "## " subheadings,
 * and runs of "- " paragraphs (the worker keeps a list item's leading "- ") as one list.
 */
function blocks(body: string): Block[] {
  const text = body.replace(/\r\n?/g, "\n").trim();
  const parts = /\n[ \t]*\n/.test(text) ? text.split(/\n[ \t]*\n+/) : text.split(/\n+/);
  const out: Block[] = [];
  for (const s of parts.map((x) => x.trim()).filter(Boolean)) {
    const joined = s.replace(/[ \t]*\n[ \t]*/g, " ");
    const h = /^#{1,3}\s+(.+)$/.exec(joined);
    const li = /^[-•*]\s+(.+)$/.exec(joined);
    const last = out[out.length - 1];
    if (h) out.push({ kind: "h", text: h[1] });
    else if (li && last?.kind === "ul") last.items.push(li[1]);
    else if (li) out.push({ kind: "ul", items: [li[1]] });
    else out.push({ kind: "p", text: joined });
  }
  return out;
}

const ARABIC_SCRIPT = /[؀-ۿ]/;
/** Urdu reading speed used across the site (lib/view.ts readingMinutes). */
const URDU_WPM = 160;

export default async function ArticlePage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  const itemId = storyIdFrom(id);
  if (!isLocale(locale) || !itemId) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  const sp = await searchParams;
  const fromId = storyIdFrom(typeof sp.from === "string" ? sp.from : "");
  const user = await requireUser({ locale: l, next: `/${l}/article/${itemId}${fromId ? `?from=${fromId}` : ""}` });
  const art = await articleForReader(itemId);
  if (!art) notFound();
  const { item } = art;
  const back = art.citing.find((c) => c.id === fromId) ?? art.citing[0];
  const refusal = translationRefusal(item);
  const [t, te, prefs, labels, poll, usage] = await Promise.all([
    getTranslations({ locale: l, namespace: "translation" }), getTranslations({ locale: l, namespace: "edition" }), getSitePrefs(),
    l === "ur" ? getGlossaryMap() : Promise.resolve(new Map<string, string>()),
    refusal ? Promise.resolve(null) : translationPoll(itemId),
    dailyUsage(user),
  ]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  const num = (s: string) => localDigits(s, l, digits);
  const outletUr = labels.get(item.source.name.toLowerCase());
  const outletName = outletUr ?? item.source.name;
  const outlet = (c: React.ReactNode) => <bdi className={outletUr ? undefined : "latin"}>{c}</bdi>;
  const href = httpHref(item.url);
  // The stored translation, when there is text to show.
  const shown = art.translation?.status === "done" && art.translation.body ? art.translation : null;
  const status = poll?.status ?? "none";
  const left = Math.max(0, usage.limit - usage.used);
  const backTitle = picked(back, "title", l);
  const when = (d: Date) => `${formatDate(d, l, { dateStyle: "medium" }, digits)} · ${formatTime(d, l, digits)}`;
  // The original headline is in the article's own language: its lang, and its direction from its text.
  const original = <span lang={item.lang || "en"} dir="auto" className={ARABIC_SCRIPT.test(item.title) ? undefined : "latin"}>{item.title}</span>;

  const originalLink = href && (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-semibold">
      {t.rich("openOriginal", { outlet: outletName, o: outlet })}
    </a>
  );
  // "Could not get the full text, here is the link" (D9): the original headline, linked.
  const sourceLink = href && <><span>{t("hereIsLink")}</span> <a href={href} target="_blank" rel="noopener noreferrer">{original}</a></>;
  const facts = [
    // The original's date (D9); a feed that gave none still gets the day we first saw it, said as such.
    item.publishedAt ? t("published", { date: when(item.publishedAt) }) : t("firstSeen", { date: when(item.firstSeenAt) }),
    shown?.finishedAt ? t("translatedOn", { date: when(shown.finishedAt) }) : null,
    shown?.sourceWords ? num(t("words", { count: shown.sourceWords })) : null,
  ].filter((x): x is string => !!x);

  return (
    <article className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <nav aria-label="Breadcrumb" className="ui meta pt-4">
        <Link href={`/story/${back.id}`}>
          {/* One child: Wazeh makes nav links inline-flex, which would set the label and the title side by side. */}
          <span><span aria-hidden="true">{l === "ur" ? "→ " : "← "}</span>{t("backToStory")}: <span {...langAttrs(backTitle.lang, l)}>{backTitle.text}</span></span>
        </Link>
      </nav>

      <header className="rule-strong mt-3 pt-4">
        <p className="ui text-[length:var(--step--1)] font-semibold uppercase tracking-wide text-accent">{t("pageTitle")}</p>
        {shown?.title ? (
          <h1 className="display mt-3 text-[length:var(--step-3)]" {...langAttrs("ur", l)}>{shown.title}</h1>
        ) : (
          <h1 className="display mt-3 text-[length:var(--step-2)]">{original}</h1>
        )}
        <p className="meta mt-3">
          <span className="font-semibold">{outlet(outletName)}</span>
          {/* Isolated, so on an Urdu page the English perspective does not reorder around the outlet's name. */}
          {item.source.perspective && <> · <bdi className="latin" lang="en" dir="ltr">{item.source.perspective}</bdi></>}
        </p>
        {shown?.title && <p className="meta mt-1">{t("originalHeadline")}: {original}</p>}
        {facts.length > 0 && <p className="meta mt-1">{facts.join(" · ")}</p>}
        {originalLink && <p className="ui mt-3">{originalLink}</p>}
      </header>

      {refusal ? (
        <section className="card mt-6 p-4">
          <p className="font-semibold">{t(`errors.${refusal}`)}</p>
          {sourceLink && <p className="mt-2">{sourceLink}</p>}
        </section>
      ) : shown ? (
        <>
          {/* The label D9 requires, before the text, and again after it. */}
          <aside className="card mt-6 border-2 !border-rule-strong p-4" aria-labelledby="ai-label">
            <p id="ai-label" className="ui font-semibold">{t.rich("label", { outlet: outletName, o: outlet })}</p>
            <p className="meta mt-1">{t("labelHint")}</p>
            {shown.checkOk === false && <p className="mt-2 font-semibold text-warn">{t("checkWarning")}</p>}
            <p className="meta mt-1">{num(te("readingTime", { minutes: Math.max(1, Math.round((shown.body ?? "").split(/\s+/).length / URDU_WPM)) }))}</p>
          </aside>
          <div className="prose measure mt-8" {...langAttrs("ur", l)}>
            {blocks(shown.body ?? "").map((b, i) => b.kind === "h"
              ? <h2 key={i} className="headline mb-2 mt-8 text-[length:var(--step-1)]">{b.text}</h2>
              : b.kind === "ul"
                ? <ul key={i} className="list-disc ps-6">{b.items.map((x, j) => <li key={j} className="mt-1">{x}</li>)}</ul>
                : <p key={i}>{b.text}</p>)}
          </div>
          <footer className="rule-top mt-10 pt-4">
            <p className="meta">{t.rich("label", { outlet: outletName, o: outlet })}</p>
            {originalLink && <p className="ui mt-2">{originalLink}</p>}
          </footer>
        </>
      ) : status === "queued" || status === "running" || status === "done" ? (
        // "done" without text here means it finished a moment ago: the live status refreshes the page once.
        <TranslationLive itemId={itemId} fromId={fromId ?? undefined} initial={poll!} digits={digits} />
      ) : status === "blocked" ? (
        <section className="card mt-6 p-4" aria-labelledby="blocked-h">
          <h2 id="blocked-h" className="ui font-semibold">{t("blockedTitle")}</h2>
          <p className="mt-2">{t(`blockedReason.${poll?.blockedReason ?? "unreachable"}`)}</p>
          {sourceLink && <p className="mt-3">{sourceLink}</p>}
        </section>
      ) : (
        <section className="card mt-6 p-4" aria-labelledby="ask-h">
          <h2 id="ask-h" className="ui font-semibold">{status === "failed" ? t("failed") : t("notYet")}</h2>
          <p className="mt-2">{status === "failed" ? t("failedHint") : t("askIntro")}</p>
          <div className="mt-4">
            {left > 0
              ? <RequestTranslationForm itemId={itemId} storyId={back.id} label={status === "failed" ? t("tryAgain") : t("ask")} primary />
              : <p className="font-semibold text-warn">{num(t("errors.limit", { limit: usage.limit }))}</p>}
          </div>
          <p className="meta mt-3">{num(t("left", { left, limit: usage.limit }))}</p>
          {sourceLink && <p className="mt-3">{sourceLink}</p>}
        </section>
      )}

      <section className="mt-10" aria-labelledby="cited-h">
        <h2 id="cited-h" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("citedIn")}</h2>
        <ul className="mt-2 divide-y divide-rule">
          {art.citing.map((c) => {
            const title = picked(c, "title", l);
            return (
              <li key={c.id} className="py-2">
                <Link href={`/story/${c.id}`} className="headline" {...langAttrs(title.lang, l)}>{title.text}</Link>
              </li>
            );
          })}
        </ul>
      </section>
    </article>
  );
}
