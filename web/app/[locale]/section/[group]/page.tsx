import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { db, schema } from "@/db";
import { getLatestPublished, getEditionFull, getSitePrefs } from "@/lib/queries";
import { formatDate, isLocale, langAttrs, localDigits, picked, slotNames, type Locale, type Slot } from "@/lib/urdu";
import { alternatesFor, dateAt } from "@/lib/view";
import { StoryCard } from "@/components/story-card";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/lib/auth";

export const revalidate = 300;
type Params = Promise<{ locale: string; group: string }>;

async function loadGroup(slug: string) {
  return db.query.groups.findFirst({ where: eq(schema.groups.slug, slug) });
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, group } = await params;
  const g = await loadGroup(group);
  if (!g || !isLocale(locale)) return {};
  return { title: locale === "ur" ? g.nameUr : g.nameEn, alternates: alternatesFor(`/section/${g.slug}`, locale) };
}

export default async function SectionPage({ params }: { params: Params }) {
  const { locale, group } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  // The page's own check behind the proxy's and the layout's (a client-side navigation skips the layout).
  await requireUser({ locale, next: `/${locale}/section/${encodeURIComponent(group)}` });
  const l = locale as Locale;
  const g = await loadGroup(group);
  if (!g) notFound();
  const [t, latest, prefs] = await Promise.all([getTranslations(), getLatestPublished(), getSitePrefs()]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  const ed = latest ? await getEditionFull(latest.date, latest.slot as Slot) : null;
  const eg = ed?.groups.find((x) => x.groupId === g.id);
  const lead = eg ? picked(eg, "lead", l) : null;
  const stories = ed?.stories.filter((s) => s.groupId === g.id).sort((a, b) => a.order - b.order) ?? [];
  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <h1 className="display rule-strong mt-4 pt-4 text-[length:var(--step-3)]">{l === "ur" ? g.nameUr : g.nameEn}</h1>
      {ed && (
        <p className="meta ui mt-2">
          <Link href={`/${ed.date}/${ed.slot}`}>{formatDate(dateAt(ed.date), l, { dateStyle: "long" }, digits)} · {slotNames[ed.slot as Slot][l]}</Link>
        </p>
      )}
      {lead?.text && <p className="headline mt-4 text-[length:var(--step-1)]" {...langAttrs(lead.lang, l)}>{lead.text}</p>}
      <div className="mt-4">
        {stories.length ? stories.map((s) => <StoryCard key={s.id} story={s} locale={l} />) : <p className="ui mt-8 text-ink-2">{localDigits(t("edition.noEdition"), l, digits)}</p>}
      </div>
    </div>
  );
}
