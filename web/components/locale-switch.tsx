"use client";
import { useLocale, useTranslations } from "next-intl";
import { getPathname, usePathname } from "@/i18n/navigation";

/**
 * Same page in the other language. Urdu label is shown in Urdu, English in English.
 * A plain link on purpose: switching language loads a new document, so the new locale's body
 * font is preloaded from <head> (Nastaliq uses font-display: optional and would otherwise miss
 * its load window inside a client-side navigation and stay in the fallback until a reload).
 * The middleware updates the locale cookie on that document request.
 */
export function LocaleSwitch() {
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations("nav");
  const other = locale === "ur" ? "en" : "ur";
  return (
    <a href={getPathname({ href: pathname, locale: other })} lang={other} dir={other === "ur" ? "rtl" : "ltr"} className="chip font-semibold" aria-label={t("languageLabel")} hrefLang={other}>
      {t("language")}
    </a>
  );
}
