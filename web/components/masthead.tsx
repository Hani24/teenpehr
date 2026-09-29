import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import type { Locale } from "@/lib/urdu";
import { getThemeBoot } from "@/lib/reader-prefs";
import { DisplayPanel, ThemeControls } from "./theme-controls";
import { LocaleSwitch } from "./locale-switch";
import { AccountMenu, AccountSection } from "./account-menu";
import { SearchBox } from "./search-box";
import { MenuButton, MenuSheet } from "./site-menu";
import { IconAbout, IconArchive, IconSaved } from "./icons";

/**
 * The bar on every reader page: the name, the sections of the site, search, the other language, the
 * display controls and the account menu. Signed out (the sign-in, invite and reset pages) only the
 * name, the language and the display controls are shown: everything else is behind the login wall
 * (decision D2) and would only lead back to sign in. The display controls work signed out; they are
 * kept on the device until the reader signs in.
 *
 * On phones (under `sm`, 40rem) the bar is slim and sticky: the name, the other language and Menu,
 * never taller than one row of 48px targets (64px in Wazeh). Today, Search and the X board are in the
 * bottom navigation (components/site-menu.tsx, rendered at the end of the page by the layout), and
 * the menu sheet holds the Wazeh text size, the other pages, the account and every display choice.
 * Tablets and desktops keep the full bar below, unchanged.
 */
export async function Masthead({ locale }: { locale: Locale }) {
  const [t, ts, tsaved, boot, user, tboard] = await Promise.all([
    getTranslations("nav"), getTranslations("site"), getTranslations("saved"), getThemeBoot(), getCurrentUser(), getTranslations("board"),
  ]);
  const link = "no-underline hover:underline";
  return (
    <>
      <header className="masthead no-print border-b border-rule bg-paper" data-topbar="">
        {/* Phones only: one row, never wrapping (globals.css, "phones"). */}
        <div className="masthead-bar">
          <Link href="/" className="masthead-title masthead-bar-title">{ts("name")}</Link>
          <LocaleSwitch className="bar-btn" />
          <MenuButton variant="bar" signedIn={!!user} />
        </div>
        {/* Tablets and desktops. ThemeControls stays mounted on phones (hidden): it applies and syncs the choices. */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-[var(--gutter)] py-3 max-sm:hidden">
          <Link href="/" className="masthead-title text-[length:var(--step-2)] no-underline text-ink">
            {ts("name")}
          </Link>
          {user && (
            <nav aria-label={t("primary")} className="ui flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--step-0)]">
              <Link href="/" className={link}>{t("today")}</Link>
              <Link href="/archive" className={link}>{t("archive")}</Link>
              <Link href="/x" className={link}>{tboard("nav")}</Link>
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
        <div className="max-sm:hidden"><DisplayPanel boot={boot} /></div>
        <p className="sr-only" lang={locale}>{ts("tagline")}</p>
      </header>
      {/* The phone menu (a modal dialog, shown only when opened). */}
      <MenuSheet boot={boot} signedIn={!!user}>
        {user && (
          <>
            <nav aria-label={t("pages")} className="sheet-section">
              <ul className="sheet-list">
                <li><Link href="/saved" className="sheet-link"><IconSaved />{tsaved("title")}</Link></li>
                <li><Link href="/archive" className="sheet-link"><IconArchive />{t("archive")}</Link></li>
                <li><Link href="/about" className="sheet-link"><IconAbout />{t("about")}</Link></li>
              </ul>
            </nav>
            <AccountSection locale={locale} />
          </>
        )}
      </MenuSheet>
    </>
  );
}
