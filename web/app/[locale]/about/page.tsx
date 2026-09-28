import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { db, schema } from "@/db";
import { getGroups, getSitePrefs } from "@/lib/queries";
import { isLocale, localDigits, type Locale } from "@/lib/urdu";
import { alternatesFor } from "@/lib/view";
import { requireUser } from "@/lib/auth";

export const revalidate = 3600;

/**
 * Quran 49:6 (al-Hujurat), the verse the name comes from (decision D1), in the Tanzil "simple" text
 * with full diacritics (Hafs). Arabic, not Urdu: it keeps the Arabic yeh and kaf, is marked lang="ar",
 * and is always set in Naskh (app/globals.css), never Nastaliq.
 */
const VERSE_49_6 = "يَا أَيُّهَا الَّذِينَ آمَنُوا إِن جَاءَكُمْ فَاسِقٌ بِنَبَإٍ فَتَبَيَّنُوا أَن تُصِيبُوا قَوْمًا بِجَهَالَةٍ فَتُصْبِحُوا عَلَىٰ مَا فَعَلْتُمْ نَادِمِينَ";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "about" });
  return { title: t("title"), alternates: isLocale(locale) ? alternatesFor("/about", locale) : undefined };
}

export default async function AboutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  // The page's own check behind the proxy's and the layout's (a client-side navigation skips the layout).
  await requireUser({ locale, next: `/${locale}/about` });
  const l = (isLocale(locale) ? locale : "en") as Locale;
  const [t, ti] = await Promise.all([getTranslations("about"), getTranslations("images")]);
  const [groups, sources, handles, prefs] = await Promise.all([
    getGroups(),
    db.select().from(schema.sources).where(and(eq(schema.sources.active, true), isNull(schema.sources.archivedAt))).orderBy(schema.sources.name),
    db.select().from(schema.handles).where(eq(schema.handles.active, true)).orderBy(schema.handles.handle),
    getSitePrefs(),
  ]);
  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <h1 className="display rule-strong mt-4 pt-4 text-[length:var(--step-3)]">{t("title")}</h1>
      <p className="prose measure mt-4 text-[length:var(--step-1)]">{t("intro")}</p>
      <section className="mt-8" aria-labelledby="name">
        <h2 id="name" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("nameTitle")}</h2>
        <figure className="mt-4">
          <blockquote lang="ar" dir="rtl" className="verse measure">{VERSE_49_6}</blockquote>
          <figcaption className="meta mt-2">{localDigits(t("verseRef"), l, prefs.digitsUr)}</figcaption>
        </figure>
        <p className="prose measure mt-3">{t("verseGist")}</p>
        <p className="prose measure mt-3">{t.rich("nameText", { ur: (chunks) => <span lang="ur">{chunks}</span> })}</p>
      </section>
      <section className="mt-8" aria-labelledby="src">
        <h2 id="src" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("sources")}</h2>
        {groups.map((g) => {
          const list = sources.filter((s) => s.groupId === g.id && s.kind !== "youtube");
          if (!list.length) return null;
          return (
            <div key={g.id} className="mt-4">
              <h3 className="ui font-semibold">{l === "ur" ? g.nameUr : g.nameEn}</h3>
              <ul className="mt-1 flex flex-wrap gap-2">
                {list.map((s) => <li key={s.id}><span className="chip latin" title={s.perspective}>{s.name}</span></li>)}
              </ul>
            </div>
          );
        })}
      </section>
      <section className="mt-8" aria-labelledby="hnd">
        <h2 id="hnd" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("handles")}</h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {handles.map((h) => <li key={h.id}><span className="chip latin">{h.platform === "x" ? "@" : ""}{h.handle}</span></li>)}
        </ul>
      </section>
      {/* Publisher images (D6): whose they are, how they are shown, what is never done with them. */}
      <section className="mt-8" aria-labelledby="img">
        <h2 id="img" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{ti("policyTitle")}</h2>
        <p className="prose measure mt-2">{ti("policyText")}</p>
      </section>
      <section className="mt-8" aria-labelledby="corr">
        <h2 id="corr" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("corrections")}</h2>
        <p className="prose measure mt-2">{t("correctionsText")}</p>
      </section>
    </div>
  );
}
