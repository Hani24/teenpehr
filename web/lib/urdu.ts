/**
 * Urdu text and locale helpers shared by the site and the admin.
 * Normalisation mirrors worker/src/teenpehr/normalize.py; keep them in sync.
 */
const ARABIC_TO_URDU: Array<[RegExp, string]> = [
  [/ي/g, "ی"], // ي → ی (Farsi yeh)
  [/ك/g, "ک"], // ك → ک (keheh)
  [/ة/g, "ۃ"], // ة → ۃ
  [/ى/g, "ی"], // ى (alef maksura) → ی
];

/** Map Arabic-preferred code points to the Urdu ones so fonts pick the Urdu forms. */
export function normalizeUrdu(text: string): string {
  let out = text.normalize("NFC");
  for (const [re, to] of ARABIC_TO_URDU) out = out.replace(re, to);
  // Final heh ه at a word end → ہ (goal heh). Medial ه is left alone (ھ/ہ differ by meaning).
  out = out.replace(/ه(?=$|[\s،؛؟۔.,;:!?)\]"'»])/g, "ہ");
  return out;
}

export type Locale = "en" | "ur";
export const locales: Locale[] = ["en", "ur"];
export const defaultLocale: Locale = "en";
export function isLocale(x: string): x is Locale { return x === "en" || x === "ur"; }
export function dirOf(locale: Locale): "ltr" | "rtl" { return locale === "ur" ? "rtl" : "ltr"; }

/** Digits preference for Urdu: CLDR default is Western ("latn"); "arabext" gives ۰۱۲۳. */
export type UrduDigits = "latn" | "arabext";
export function bcp47(locale: Locale, digits: UrduDigits = "latn"): string {
  if (locale === "en") return "en-PK";
  return digits === "arabext" ? "ur-PK-u-nu-arabext" : "ur-PK-u-nu-latn";
}

export const TZ = "Asia/Karachi";

export function formatDate(d: Date, locale: Locale, opts: Intl.DateTimeFormatOptions = { dateStyle: "full" }, digits?: UrduDigits): string {
  return new Intl.DateTimeFormat(bcp47(locale, digits), { timeZone: TZ, ...opts }).format(d);
}

/** Urdu uses the 24-hour clock (as Urdu papers do), which also avoids "PM" flipping sides in RTL text. */
export function formatTime(d: Date, locale: Locale, digits?: UrduDigits): string {
  return new Intl.DateTimeFormat(bcp47(locale, digits), { timeZone: TZ, hour: "numeric", minute: "2-digit", hourCycle: locale === "ur" ? "h23" : "h12" }).format(d);
}

/** Hijri date, computed (may drift a day from the Ruet-e-Hilal announcement). */
export function formatHijri(d: Date, locale: Locale, adjustDays = 0, digits: UrduDigits = "latn"): string {
  const shifted = new Date(d.getTime() + adjustDays * 86_400_000);
  const tag = locale === "ur" ? `ur-PK-u-ca-islamic-nu-${digits}` : "en-PK-u-ca-islamic";
  return new Intl.DateTimeFormat(tag, { timeZone: TZ, day: "numeric", month: "long", year: "numeric" }).format(shifted);
}

/** "3 hours ago" / "3 گھنٹے پہلے" */
export function relativeTime(from: Date, to: Date, locale: Locale, digits?: UrduDigits): string {
  const rtf = new Intl.RelativeTimeFormat(bcp47(locale, digits), { numeric: "always" });
  const diff = (from.getTime() - to.getTime()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function formatNumber(n: number, locale: Locale, digits?: UrduDigits): string {
  return new Intl.NumberFormat(bcp47(locale, digits)).format(n);
}

/**
 * Western → Urdu digits in a string that was already formatted, for Urdu pages set to "arabext".
 * next-intl formats `{count}` and `#` with the plain "ur" locale (Western digits), so translated
 * strings with numbers go through this; strings from formatDate/formatTime already carry the digits.
 */
export function localDigits(text: string, locale: Locale, digits?: UrduDigits): string {
  if (locale !== "ur" || digits !== "arabext") return text;
  return text.replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
}

/** Pick the localized field pair: t(story, "title") → title_ur in Urdu when present, else English. */
export function pick<T extends Record<string, unknown>>(obj: T, base: string, locale: Locale): string {
  return picked(obj, base, locale).text;
}

/** Like pick(), but also says which language the text is in, so a fallback can be marked up. */
export function picked<T extends Record<string, unknown>>(obj: T, base: string, locale: Locale): { text: string; lang: Locale } {
  const ur = obj[`${base}Ur`] as string | undefined;
  const en = obj[`${base}En`] as string | undefined;
  if (locale === "ur" && ur && ur.trim()) return { text: ur, lang: "ur" };
  return { text: en ?? "", lang: "en" };
}

/**
 * `lang`/`dir` for a run of text in `textLang` on a `pageLocale` page: nothing when they match,
 * otherwise both, so an English fallback on an Urdu page is laid out LTR in the Latin face
 * (and its trailing full stop stays on the right) instead of inheriting the page's RTL.
 */
export function langAttrs(textLang: Locale, pageLocale: Locale): { lang?: Locale; dir?: "ltr" | "rtl" } {
  return textLang === pageLocale ? {} : { lang: textLang, dir: dirOf(textLang) };
}

export const SLOTS = ["subh", "dopahar", "shaam"] as const;
export type Slot = (typeof SLOTS)[number];
export const slotNames: Record<Slot, { en: string; ur: string }> = {
  subh: { en: "Morning", ur: "صبح" },
  dopahar: { en: "Midday", ur: "دوپہر" },
  shaam: { en: "Evening", ur: "شام" },
};
