import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/urdu";
import { ThemeControls } from "./theme-controls";
import { LocaleSwitch } from "./locale-switch";

export async function Masthead({ locale }: { locale: Locale }) {
  const t = await getTranslations("nav");
  const ts = await getTranslations("site");
  return (
    <header className="no-print border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-[var(--gutter)] py-3">
        <Link href="/" className="masthead-title text-[length:var(--step-2)] no-underline text-ink" aria-label={ts("name")}>
          {ts("name")}
        </Link>
        <nav aria-label="Primary" className="ui flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--step-0)]">
          <Link href="/" className="no-underline hover:underline">{t("today")}</Link>
          <Link href="/archive" className="no-underline hover:underline">{t("archive")}</Link>
          <Link href="/about" className="no-underline hover:underline">{t("about")}</Link>
        </nav>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <LocaleSwitch />
          <ThemeControls />
        </div>
      </div>
      <p className="sr-only" lang={locale}>{ts("tagline")}</p>
    </header>
  );
}
