import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { db, schema } from "@/db";
import { getLatestPublished, getEditionFull } from "@/lib/queries";
import { formatDate, isLocale, pick, slotNames, type Locale, type Slot } from "@/lib/urdu";
import { dateAt } from "@/lib/view";
import { StoryCard } from "@/components/story-card";
import { Link } from "@/i18n/navigation";

export const revalidate = 300;
type Params = Promise<{ locale: string; group: string }>;

async function loadGroup(slug: string) {
  return db.query.groups.findFirst({ where: eq(schema.groups.slug, slug) });
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, group } = await params;
  const g = await loadGroup(group);
  if (!g) return {};
  return { title: locale === "ur" ? g.nameUr : g.nameEn };
}

export default async function SectionPage({ params }: { params: Params }) {
  const { locale, group } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  const g = await loadGroup(group);
  if (!g) notFound();
  const t = await getTranslations();
  const latest = await getLatestPublished();
  const ed = latest ? await getEditionFull(latest.date, latest.slot as Slot) : null;
  const eg = ed?.groups.find((x) => x.groupId === g.id);
  const stories = ed?.stories.filter((s) => s.groupId === g.id).sort((a, b) => a.order - b.order) ?? [];
  const now = new Date();
  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <h1 className="display rule-strong mt-4 pt-4 text-[length:var(--step-3)]">{l === "ur" ? g.nameUr : g.nameEn}</h1>
      {ed && (
        <p className="meta ui mt-2">
          <Link href={`/${ed.date}/${ed.slot}`}>{formatDate(dateAt(ed.date), l, { dateStyle: "long" })} · {slotNames[ed.slot as Slot][l]}</Link>
        </p>
      )}
      {eg && pick(eg, "lead", l) && <p className="headline mt-4 text-[length:var(--step-1)]">{pick(eg, "lead", l)}</p>}
      <div className="mt-4">
        {stories.length ? stories.map((s) => <StoryCard key={s.id} story={s} locale={l} now={now} />) : <p className="ui mt-8 text-ink-2">{t("edition.noEdition")}</p>}
      </div>
    </div>
  );
}
