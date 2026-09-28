import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { loadEditionPage } from "@/lib/edition-page";
import { getSitePrefs } from "@/lib/queries";
import { EditionView } from "@/components/edition-view";
import { formatDate, isLocale, pick, SLOTS, type Locale, type Slot } from "@/lib/urdu";
import { alternatesFor, dateAt, isEditionDate, needToKnow } from "@/lib/view";
import { requireUser } from "@/lib/auth";

export const revalidate = 3600;

type Params = Promise<{ locale: string; date: string; slot: string }>;

function valid(date: string, slot: string): slot is Slot {
  return isEditionDate(date) && (SLOTS as readonly string[]).includes(slot);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, date, slot } = await params;
  if (!isLocale(locale) || !valid(date, slot)) return {};
  const page = await loadEditionPage(date, slot);
  if (!page) return {};
  const [t, prefs] = await Promise.all([getTranslations({ locale, namespace: "slots" }), getSitePrefs()]);
  const top = needToKnow(page.ed, 3).map((s) => pick(s, "title", locale)).join(" · ");
  const digits = locale === "ur" ? prefs.digitsUr : undefined;
  return {
    title: `${t(`${slot}Long`)} · ${formatDate(dateAt(date), locale, { dateStyle: "long" }, digits)}`,
    description: top || undefined,
    alternates: alternatesFor(`/${date}/${slot}`, locale),
  };
}

export default async function EditionPage({ params }: { params: Params }) {
  const { locale, date, slot } = await params;
  if (!isLocale(locale) || !valid(date, slot)) notFound();
  setRequestLocale(locale);
  // The page's own check behind the proxy's and the layout's (a client-side navigation skips the layout).
  await requireUser({ locale, next: `/${locale}/${date}/${slot}` });
  const page = await loadEditionPage(date, slot);
  if (!page) notFound();
  return <EditionView ed={page.ed} locale={locale as Locale} published={page.published} prev={page.prev} next={page.next} />;
}
