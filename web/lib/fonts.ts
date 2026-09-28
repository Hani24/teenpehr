import localFont from "next/font/local";

/*
 * All self-hosted, OFL, subset by scripts/fonts.sh.
 *
 * Latin faces go through next/font. Inter (body and UI) is preloaded on every page; it is also the
 * Latin fallback inside Urdu text. The italic is not loaded: nothing on the site sets italics, and
 * a second preloaded 115 KB face competed with the Urdu body font on Urdu pages.
 *
 * Urdu faces are declared here by hand (urduFontCss, rendered in the locale layout's <head>)
 * because next/font can only preload a face on every route of a layout, and the plan is to preload
 * the current locale's body font only: Nastaliq on Urdu pages, nothing Urdu on English pages. Its
 * URL has to be known to preload it, so the files are served from public/fonts/ (immutable cache,
 * see next.config.ts) with FONT_VERSION in the query; bump it whenever scripts/fonts.sh re-subsets.
 */
export const inter = localFont({
  src: [{ path: "../public/fonts/InterVariable.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter",
  display: "swap",
  preload: true,
});

export const newsreader = localFont({
  src: [{ path: "../public/fonts/Newsreader[opsz,wght].woff2", weight: "200 800", style: "normal" }],
  variable: "--font-newsreader",
  display: "swap",
  preload: false,
});

export const fontVariables = [inter.variable, newsreader.variable].join(" ");

const FONT_VERSION = "2";
/** What scripts/fonts.sh keeps in the Urdu faces: Arabic blocks plus space, digits and ASCII punctuation (no Latin letters). */
const URDU_RANGE = "U+0020-0040,U+005B-0060,U+007B-007E,U+00A0,U+00AB,U+00BB,U+0600-06FF,U+0750-077F,U+0870-088E,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFC,U+200C-200F,U+2010-2011";

type Face = { variable: string; family: string; file: string; weight: string; display: "swap" | "optional" };
const face = (f: Face) => ({ ...f, href: `/fonts/${encodeURIComponent(f.file)}?v=${FONT_VERSION}` });

export const urduFaces = {
  /** Headlines everywhere, body in Classic and Night. optional: a late load never reflows a page from Naskh to Nastaliq metrics. */
  nastaliq: face({ variable: "--font-nastaliq", family: "Noto Nastaliq Urdu Web", file: "NotoNastaliqUrdu[wght].woff2", weight: "400 700", display: "optional" }),
  /** Body in the large-type theme; fallback for Nastaliq. */
  naskh: face({ variable: "--font-naskh", family: "Noto Naskh Arabic Web", file: "NotoNaskhArabic[wght].woff2", weight: "400 700", display: "swap" }),
  /** UI and small text (never Nastaliq under 20 px). */
  vazir: face({ variable: "--font-vazir", family: "Vazirmatn Web", file: "Vazirmatn[wght].woff2", weight: "100 900", display: "swap" }),
};

/** The Urdu body font preloaded on Urdu pages. */
export const urduBodyFont = urduFaces.nastaliq;

/** @font-face rules plus the --font-* variables globals.css builds its Urdu stacks from. */
export const urduFontCss =
  Object.values(urduFaces).map((f) =>
    `@font-face{font-family:"${f.family}";src:url("${f.href}") format("woff2");font-weight:${f.weight};font-style:normal;font-display:${f.display};unicode-range:${URDU_RANGE}}`,
  ).join("") +
  `:root{${Object.values(urduFaces).map((f) => `${f.variable}:"${f.family}"`).join(";")}}`;
