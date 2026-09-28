import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/lib/auth";
import { getSitePrefs } from "@/lib/queries";
import { topicCounts } from "@/lib/search";
import { TOPICS, topicLabel } from "@/lib/taxonomy";
import { isLocale, localDigits, type Locale } from "@/lib/urdu";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: (await getTranslations({ locale, namespace: "topics" }))("title") };
}

/** Every topic with its number of published stories. */
export default async function TopicsPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  await requireUser({ locale: l, next: `/${l}/topic` });
  const [t, prefs, counts] = await Promise.all([getTranslations({ locale: l, namespace: "topics" }), getSitePrefs(), topicCounts()]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <h1 className="display rule-strong mt-4 pt-4 text-[length:var(--step-3)]">{t("title")}</h1>
      <p className="meta mt-2 measure">{t("intro")}</p>
      <ul className="ui mt-6 grid gap-2 sm:grid-cols-2">
        {TOPICS.map((x) => (
          <li key={x}>
            <Link href={`/topic/${x}`} prefetch={false} className="flex items-baseline justify-between gap-3 rounded-[var(--radius)] border border-rule bg-surface px-3 py-2 no-underline hover:border-rule-strong">
              <span className="text-ink">{topicLabel(x, l)}</span>
              <span className="meta">{localDigits(t("count", { count: counts.get(x) ?? 0 }), l, digits)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
