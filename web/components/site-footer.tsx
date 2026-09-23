import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/urdu";

export async function SiteFooter({ locale }: { locale: Locale }) {
  const t = await getTranslations("footer");
  const ts = await getTranslations("site");
  const ta = await getTranslations("about");
  return (
    <footer className="no-print mt-16 border-t border-rule bg-surface-2">
      <div className="mx-auto max-w-6xl px-[var(--gutter)] py-8 text-[length:var(--step--1)] text-ink-2">
        <p className="measure">{ts("disclosure")}</p>
        <div className="ui mt-4 flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/about">{ta("title")}</Link>
          <a href={`/${locale}/feed.xml`}>{t("rss")}</a>
          <a href={`/${locale}/feed.json`}>{t("json")}</a>
        </div>
        <p className="mt-4">{ts("name")} · {t("madeBy")}</p>
      </div>
    </footer>
  );
}
