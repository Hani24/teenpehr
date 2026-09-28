import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { isLocale } from "@/lib/urdu";
import { OfflineList, RetryButton } from "./offline-list";

/*
 * The page public/sw.js shows when a page cannot load and no copy is kept on this device (it is
 * kept at install and on every sync). Nothing here is per-reader: the list of kept pages comes from
 * the service worker, in the browser.
 */
type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "offline" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default async function OfflinePage({ params }: { params: Params }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("offline");
  return (
    <div className="page mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <header className="rule-strong mt-4 pt-4">
        <h1 className="display text-[length:var(--step-3)]">{t("title")}</h1>
        <p className="measure mt-2 text-ink-2">{t("text")}</p>
        <p className="ui mt-4"><RetryButton /></p>
      </header>
      <OfflineList />
    </div>
  );
}
