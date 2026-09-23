import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { fontVariables } from "@/lib/fonts";
import { dirOf, type Locale } from "@/lib/urdu";
import { Masthead } from "@/components/masthead";
import { SiteFooter } from "@/components/site-footer";
import { BackToTop } from "@/components/back-to-top";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "site" });
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
    metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
    alternates: { languages: { en: "/en", ur: "/ur" } },
    openGraph: { siteName: t("name"), locale: locale === "ur" ? "ur_PK" : "en_PK", type: "website" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f7f3ec" }, { media: "(prefers-color-scheme: dark)", color: "#0f1115" }],
};

/** Runs before paint: apply the stored theme, size and contrast so nothing flashes. */
const bootScript = `(function(){try{var d=document.documentElement,t=localStorage.getItem('tp-theme');if(!t||t==='system'){t=matchMedia('(prefers-color-scheme: dark)').matches?'night':'classic'}d.dataset.theme=t;var s=localStorage.getItem('tp-size');if(s)d.dataset.size=s;var c=localStorage.getItem('tp-contrast');if(c==='high')d.dataset.contrast='high';if(localStorage.getItem('tp-nastaliq')==='1')d.classList.add('nastaliq')}catch(e){}})();`;

export default async function LocaleLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  return (
    <html lang={l} dir={dirOf(l)} className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootScript }} />
      </head>
      <body className="min-h-dvh flex flex-col bg-paper text-ink">
        <NextIntlClientProvider>
          <a href="#content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink">
            {locale === "ur" ? "مواد پر جائیں" : "Skip to content"}
          </a>
          <Masthead locale={l} />
          <main id="content" className="flex-1">{children}</main>
          <SiteFooter locale={l} />
          <BackToTop />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
