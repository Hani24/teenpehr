"use client";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

/** Same page in the other language. Urdu label is shown in Urdu, English in English. */
export function LocaleSwitch() {
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations("nav");
  const other = locale === "ur" ? "en" : "ur";
  return (
    <Link href={pathname} locale={other} lang={other} dir={other === "ur" ? "rtl" : "ltr"} className="chip font-semibold" aria-label={t("languageLabel")} hrefLang={other}>
      {t("language")}
    </Link>
  );
}
