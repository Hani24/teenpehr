import { getTranslations, setRequestLocale } from "next-intl/server";
import { getLatestPublished } from "@/lib/queries";
import { loadEditionPage } from "@/lib/edition-page";
import { EditionView } from "@/components/edition-view";
import { type Locale, type Slot } from "@/lib/urdu";

export const revalidate = 300;

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const latest = await getLatestPublished();
  const page = latest ? await loadEditionPage(latest.date, latest.slot as Slot) : null;
  if (!page) return <EmptyState />;
  return <EditionView ed={page.ed} locale={locale as Locale} published={page.published} prev={page.prev} next={page.next} settings={page.settings} />;
}

async function EmptyState() {
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] py-24 text-center">
      <h1 className="display text-[length:var(--step-3)]">{t("site.name")}</h1>
      <p className="mt-3 text-[length:var(--step-1)] text-ink-2">{t("site.tagline")}</p>
      <p className="ui mt-8 text-ink-2">{t("edition.noEdition")}</p>
    </div>
  );
}
