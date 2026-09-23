import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { EditionFull } from "@/lib/queries";
import { formatDate, formatHijri, formatTime, SLOTS, slotNames, type Locale, type Slot } from "@/lib/urdu";
import { dateAt, distinctSourceCount, readingMinutes } from "@/lib/view";

type Neighbour = { date: string; slot: string } | null;

export async function EditionHeader({ ed, locale, published, prev, next, editorName, hijriAdjust = 0 }:
  { ed: EditionFull; locale: Locale; published: Slot[]; prev: Neighbour; next: Neighbour; editorName: string; hijriAdjust?: number }) {
  const t = await getTranslations();
  const day = dateAt(ed.date);
  const sources = distinctSourceCount(ed);
  return (
    <header className="rule-strong pt-4">
      <p className="ui flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[length:var(--step--1)] text-ink-2">
        <time dateTime={ed.date} className="font-semibold text-ink">{formatDate(day, locale, { dateStyle: "full" })}</time>
        <span aria-label="Hijri date">{formatHijri(day, locale, hijriAdjust)} <span className="text-ink-3">({t("time.hijriApprox")})</span></span>
      </p>
      <h1 className="display mt-2 text-[length:var(--step-3)]">{t(`slots.${ed.slot}Long`)}</h1>
      <p className="meta mt-2">
        {ed.publishedAt && t("edition.compiledAt", { time: formatTime(ed.publishedAt, locale), count: sources })}
        {editorName && <> · {t("edition.reviewedBy", { name: editorName })}</>}
        {" · "}{t("edition.readingTime", { minutes: readingMinutes(ed, locale) })}
      </p>
      <nav aria-label={t("nav.today")} className="ui mt-4 flex flex-wrap items-center gap-2">
        {prev && <Link href={`/${prev.date}/${prev.slot}`} className="chip" rel="prev">← {t("edition.previous")}</Link>}
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
        {next && <Link href={`/${next.date}/${next.slot}`} className="chip" rel="next">{t("edition.next")} →</Link>}
      </nav>
    </header>
  );
}
