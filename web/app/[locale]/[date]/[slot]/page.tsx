import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { loadEditionPage } from "@/lib/edition-page";
import { EditionView } from "@/components/edition-view";
import { formatDate, isLocale, SLOTS, type Locale, type Slot } from "@/lib/urdu";
import { dateAt, needToKnow } from "@/lib/view";
import { pick } from "@/lib/urdu";

export const revalidate = 3600;

type Params = Promise<{ locale: string; date: string; slot: string }>;

function valid(date: string, slot: string): slot is Slot {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && (SLOTS as readonly string[]).includes(slot);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, date, slot } = await params;
  if (!isLocale(locale) || !valid(date, slot)) return {};
  const page = await loadEditionPage(date, slot);
  if (!page) return {};
  const t = await getTranslations({ locale, namespace: "slots" });
  const top = needToKnow(page.ed, 3).map((s) => pick(s, "title", locale)).join(" · ");
  return { title: `${t(`${slot}Long`)} · ${formatDate(dateAt(date), locale, { dateStyle: "long" })}`, description: top || undefined };
}

export default async function EditionPage({ params }: { params: Params }) {
  const { locale, date, slot } = await params;
  if (!isLocale(locale) || !valid(date, slot)) notFound();
  setRequestLocale(locale);
  const page = await loadEditionPage(date, slot);
  if (!page) notFound();
  return <EditionView ed={page.ed} locale={locale as Locale} published={page.published} prev={page.prev} next={page.next} settings={page.settings} />;
}
