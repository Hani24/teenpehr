import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getLatestPublished, getSitePrefs } from "@/lib/queries";
import { loadEditionPage } from "@/lib/edition-page";
import { EditionView } from "@/components/edition-view";
import { EditorsDesk } from "@/components/editors-desk";
import { isLocale, localDigits, type Locale, type Slot } from "@/lib/urdu";
import { alternatesFor } from "@/lib/view";
import { requireUser } from "@/lib/auth";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { alternates: alternatesFor("", locale) } : {};
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  // The page's own check behind the proxy's and the layout's (a client-side navigation skips the layout).
  await requireUser({ locale, next: `/${locale}` });
  const latest = await getLatestPublished();
  const page = latest ? await loadEditionPage(latest.date, latest.slot as Slot) : null;
  // Editors' stories published ahead of the next edition (D12); nothing when the desk is empty.
  const desk = <EditorsDesk locale={locale as Locale} />;
  if (!page) return <EmptyState locale={locale as Locale} desk={desk} />;
  return <EditionView ed={page.ed} locale={locale as Locale} published={page.published} prev={page.prev} next={page.next} desk={desk} />;
}

async function EmptyState({ locale, desk }: { locale: Locale; desk: React.ReactNode }) {
  const t = await getTranslations();
  const digits = locale === "ur" ? (await getSitePrefs()).digitsUr : undefined;
  return (
    <div className="page mx-auto max-w-6xl px-[var(--gutter)]">
      <div className="mx-auto max-w-3xl py-24 text-center">
        <h1 className="display text-[length:var(--step-3)]">{t("site.name")}</h1>
        <p className="mt-3 text-[length:var(--step-1)] text-ink-2">{t("site.tagline")}</p>
        <p className="ui mt-8 text-ink-2">{localDigits(t("edition.noEdition"), locale, digits)}</p>
      </div>
      {desk}
    </div>
  );
}
