import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getArchiveIndex } from "@/lib/queries";
import { formatDate, isLocale, slotNames, type Locale, type Slot } from "@/lib/urdu";
import { dateAt } from "@/lib/view";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "archive" });
  return { title: t("title") };
}

export default async function ArchivePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const l = (isLocale(locale) ? locale : "en") as Locale;
  const t = await getTranslations("archive");
  const index = await getArchiveIndex();
  const months = new Map<string, Array<[string, Slot[]]>>();
  for (const [date, slots] of index) {
    const key = date.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), [date, slots]]);
  }
  return (
    <div className="mx-auto max-w-4xl px-[var(--gutter)] pb-16">
      <h1 className="display rule-strong mt-4 pt-4 text-[length:var(--step-3)]">{t("title")}</h1>
      <p className="meta mt-2">{t("byDate")}</p>
      {months.size === 0 && <p className="ui mt-8 text-ink-2">{t("noEditions")}</p>}
      {[...months].map(([month, days]) => (
        <section key={month} className="mt-8" aria-labelledby={`m-${month}`}>
          <h2 id={`m-${month}`} className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{formatDate(dateAt(`${month}-01`), l, { month: "long", year: "numeric" })}</h2>
          <ul className="mt-2 divide-y divide-rule">
            {days.map(([date, slots]) => (
              <li key={date} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <time dateTime={date} className="ui min-w-[14ch] font-semibold">{formatDate(dateAt(date), l, { weekday: "short", day: "numeric", month: "short" })}</time>
                <span className="ui flex flex-wrap gap-2">
                  {slots.map((s) => <Link key={s} href={`/${date}/${s}`} className="chip">{slotNames[s][l]}</Link>)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
