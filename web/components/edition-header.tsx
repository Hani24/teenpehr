import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { EditionFull } from "@/lib/queries";
import { getSitePrefs } from "@/lib/queries";
import { dirOf, formatDate, formatHijri, formatTime, localDigits, SLOTS, slotNames, type Locale, type Slot } from "@/lib/urdu";
import { dateAt, distinctSourceCount, readingMinutes } from "@/lib/view";
import { editionSavedState } from "@/lib/saved";
import { SaveButton } from "./save-button";
import { DownloadMenu } from "./download-menu";

type Neighbour = { date: string; slot: string } | null;

export async function EditionHeader({ ed, locale, published, prev, next }:
  { ed: EditionFull; locale: Locale; published: Slot[]; prev: Neighbour; next: Neighbour }) {
  const t = await getTranslations();
  const prefs = await getSitePrefs();
  const digits = locale === "ur" ? prefs.digitsUr : undefined;
  const num = (s: string) => localDigits(s, locale, digits);
  const day = dateAt(ed.date);
  const sources = distinctSourceCount(ed);
  // Arrows point along the reading direction: in Urdu "previous" is on the right and points right.
  const rtl = dirOf(locale) === "rtl";
  const back = rtl ? "→" : "←", forward = rtl ? "←" : "→";
  const saved = await editionSavedState(ed.id);
  return (
    <header className="rule-strong pt-4">
      <p className="ui flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[length:var(--step--1)] text-ink-2">
        <time dateTime={ed.date} className="font-semibold text-ink">{formatDate(day, locale, { dateStyle: "full" }, digits)}</time>
        <span aria-label="Hijri date">{formatHijri(day, locale, prefs.hijriAdjust, digits)} <span className="text-ink-3">({t("time.hijriApprox")})</span></span>
      </p>
      <h1 className="display mt-2 text-[length:var(--step-3)]">{t(`slots.${ed.slot}Long`)}</h1>
      <p className="meta mt-2">
        {ed.publishedAt && num(t("edition.compiledAt", { time: formatTime(ed.publishedAt, locale, digits), count: sources }))}
        {prefs.editorName && <> · {t("edition.reviewedBy", { name: prefs.editorName })}</>}
        {" · "}{num(t("edition.readingTime", { minutes: readingMinutes(ed, locale) }))}
      </p>
      <nav aria-label={t("nav.today")} className="ui mt-4 flex flex-wrap items-center gap-2">
        {prev && <Link href={`/${prev.date}/${prev.slot}`} className="chip" rel="prev"><span aria-hidden="true">{back}</span> {t("edition.previous")}</Link>}
        <span role="group" aria-label={ed.date} className="inline-flex gap-1">
          {SLOTS.map((s) => {
            const on = published.includes(s);
            const active = s === ed.slot;
            return on ? (
              <Link key={s} href={`/${ed.date}/${s}`} aria-current={active ? "page" : undefined} className={`chip ${active ? "!border-rule-strong !bg-ink !text-paper" : ""}`}>{slotNames[s][locale]}</Link>
            ) : (
              <span key={s} className="chip opacity-50" aria-disabled="true">{slotNames[s][locale]}</span>
            );
          })}
        </span>
        {next && <Link href={`/${next.date}/${next.slot}`} className="chip" rel="next">{t("edition.next")} <span aria-hidden="true">{forward}</span></Link>}
      </nav>
      {/* Save the whole edition, print it to PDF, or download it as one file (D3); signed-in readers. */}
      {saved !== null && (
        <div className="ui no-print mt-3 flex flex-wrap items-center gap-2">
          <SaveButton kind="edition" id={ed.id} saved={saved} label={t("saved.saveEdition")} />
          <DownloadMenu date={ed.date} slot={ed.slot} />
        </div>
      )}
    </header>
  );
}
