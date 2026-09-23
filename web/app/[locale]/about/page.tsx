import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { db, schema } from "@/db";
import { getGroups } from "@/lib/queries";
import { isLocale, type Locale } from "@/lib/urdu";

export const revalidate = 3600;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "about" });
  return { title: t("title") };
}

export default async function AboutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const l = (isLocale(locale) ? locale : "en") as Locale;
  const t = await getTranslations("about");
  const [groups, sources, handles] = await Promise.all([
    getGroups(),
    db.select().from(schema.sources).where(eq(schema.sources.active, true)).orderBy(schema.sources.name),
    db.select().from(schema.handles).where(eq(schema.handles.active, true)).orderBy(schema.handles.handle),
  ]);
  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <h1 className="display rule-strong mt-4 pt-4 text-[length:var(--step-3)]">{t("title")}</h1>
      <p className="prose measure mt-4 text-[length:var(--step-1)]">{t("intro")}</p>
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
      <section className="mt-8" aria-labelledby="corr">
        <h2 id="corr" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("corrections")}</h2>
        <p className="prose measure mt-2">{t("correctionsText")}</p>
      </section>
    </div>
  );
}
