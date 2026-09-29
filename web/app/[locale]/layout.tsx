import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { preload } from "react-dom";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { gateReader } from "@/lib/auth/gate";
import { fontVariables, urduBodyFont, urduFontCss } from "@/lib/fonts";
import { getThemeBoot } from "@/lib/reader-prefs";
import { dirOf, type Locale } from "@/lib/urdu";
import { bootScript, hiddenGroupCss, paletteBg, renderedPrefs, SYSTEM_DARK, SYSTEM_LIGHT, themeAttrs } from "@/lib/view";
import { Masthead } from "@/components/masthead";
import { SiteFooter } from "@/components/site-footer";
import { BackToTop } from "@/components/back-to-top";
import { BottomNav } from "@/components/site-menu";
import { OfflineBanner } from "@/components/offline-banner";
import { SwRegister } from "@/components/sw-register";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "site" });
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("description"),
    metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
    // hreflang alternates are per page (alternatesFor in lib/view.ts): set here, every story and
    // edition page would name the home pages as its translations.
    openGraph: { siteName: t("name"), locale: locale === "ur" ? "ur_PK" : "en_PK", type: "website" },
    // Invite-only (D2): nothing here is for search engines (also robots.txt and X-Robots-Tag).
    robots: { index: false, follow: false, nocache: true },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // "system" palette colours; components/theme-controls.tsx points these at the reader's palette.
  themeColor: [{ media: "(prefers-color-scheme: light)", color: paletteBg(SYSTEM_LIGHT) }, { media: "(prefers-color-scheme: dark)", color: paletteBg(SYSTEM_DARK) }],
};

export default async function LocaleLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // Login wall, second layer (the proxy is the first): signed out, only the sign-in pages render.
  const reader = await gateReader(locale as Locale);
  const l = locale as Locale;
  // Preload only this locale's body font. Inter (English) is preloaded by next/font; Nastaliq is
  // font-display: optional, so on Urdu pages it must be requested from <head> to arrive in time.
  if (l === "ur") preload(urduBodyFont.href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  // Palette and Wazeh mode (D4): <html> carries the reader's saved choices, so a new device does not
  // flash; the boot script then applies this device's own choices before paint (lib/view.ts).
  const boot = await getThemeBoot();
  // Client components get every namespace but the admin's (Insights is rendered on the server, in English).
  const { insights, ...clientMessages } = await getMessages();
  void insights;
  return (
    <html lang={l} dir={dirOf(l)} className={fontVariables} {...themeAttrs(renderedPrefs(boot))} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootScript(boot) }} />
        <style dangerouslySetInnerHTML={{ __html: urduFontCss + hiddenGroupCss() }} />
      </head>
      <body className="min-h-dvh flex flex-col bg-paper text-ink">
        <NextIntlClientProvider messages={clientMessages}>
          <a href="#content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink">
            {locale === "ur" ? "مواد پر جائیں" : "Skip to content"}
          </a>
          <OfflineBanner />
          <Masthead locale={l} />
          <main id="content" className="flex-1">{children}</main>
          <SiteFooter locale={l} />
          {/* Phones, signed in: Today, Search, the X board and Menu at the bottom of the screen (components/site-menu.tsx). */}
          {reader && <BottomNav />}
          <BackToTop raised={!!reader} />
          {/* The account id: offline copies kept for another account on this browser are dropped (D3). */}
          <SwRegister owner={reader ? String(reader.id) : null} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
