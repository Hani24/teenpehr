import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/urdu";

const Glass = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4.5 4.5" /></svg>
);

/**
 * `compact`: the masthead's entry, a link to the search page (the bar has no room for a field). Otherwise
 * the search form: a plain GET to /{locale}/search, so it works before hydration and without script, with
 * the page's filters inside it (`children`) so the words and the filters are submitted together.
 */
export async function SearchBox({ locale, q = "", compact = false, children }: { locale: Locale; q?: string; compact?: boolean; children?: React.ReactNode }) {
  const t = await getTranslations({ locale, namespace: "search" });
  if (compact) return <Link href="/search" prefetch={false} className="chip ui"><Glass />{t("entry")}</Link>;
  return (
    <form role="search" action={`/${locale}/search`} method="get" className="ui w-full">
      <div className="flex items-stretch gap-2">
        <label htmlFor="search-q" className="sr-only">{t("label")}</label>
        <input
          id="search-q" type="search" name="q" defaultValue={q} maxLength={200} autoComplete="off" enterKeyHint="search" placeholder={t("placeholder")} dir="auto"
          className="min-w-0 flex-1 rounded-[var(--radius)] border border-rule bg-surface px-3 py-1.5 text-[length:var(--step-1)] text-ink placeholder:text-ink-3"
        />
        <button type="submit" className="chip !min-h-[2.75rem] px-4 font-semibold text-ink"><Glass /><span>{t("submit")}</span></button>
      </div>
      {children}
    </form>
  );
}
