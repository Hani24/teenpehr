import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import type { Locale } from "@/lib/urdu";
import { getThemeBoot } from "@/lib/reader-prefs";
import { DisplayPanel, ThemeControls } from "./theme-controls";
import { LocaleSwitch } from "./locale-switch";
import { AccountMenu } from "./account-menu";
import { SearchBox } from "./search-box";

/**
 * The bar on every reader page: the name, the sections of the site, search, the other language, the
 * display controls and the account menu. Signed out (the sign-in, invite and reset pages) only the
 * name, the language and the display controls are shown: everything else is behind the login wall
 * (decision D2) and would only lead back to sign in. The display controls work signed out; they are
 * kept on the device until the reader signs in.
 */
export async function Masthead({ locale }: { locale: Locale }) {
  const [t, ts, tsaved, boot, user] = await Promise.all([
    getTranslations("nav"), getTranslations("site"), getTranslations("saved"), getThemeBoot(), getCurrentUser(),
  ]);
  const link = "no-underline hover:underline";
  return (
    <header className="no-print border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-[var(--gutter)] py-3">
        <Link href="/" className="masthead-title text-[length:var(--step-2)] no-underline text-ink">
          {ts("name")}
        </Link>
        {user && (
          <nav aria-label={t("primary")} className="ui flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--step-0)]">
            <Link href="/" className={link}>{t("today")}</Link>
            <Link href="/archive" className={link}>{t("archive")}</Link>
            <Link href="/saved" className={link}>{tsaved("title")}</Link>
            <Link href="/about" className={link}>{t("about")}</Link>
          </nav>
        )}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {user && <SearchBox locale={locale} compact />}
          <LocaleSwitch />
          <ThemeControls boot={boot} />
          {user && <AccountMenu locale={locale} />}
        </div>
      </div>
      {/* Palette, Wazeh mode and the rest, opened by the Display button in the bar (focus moves into it). */}
      <DisplayPanel boot={boot} />
      <p className="sr-only" lang={locale}>{ts("tagline")}</p>
    </header>
  );
}
