import localFont from "next/font/local";

/** All self-hosted, OFL. Subset by scripts/fonts.sh. Urdu faces are loaded only on Urdu pages. */
export const inter = localFont({
  src: [
    { path: "../public/fonts/InterVariable.woff2", weight: "100 900", style: "normal" },
    { path: "../public/fonts/InterVariable-Italic.woff2", weight: "100 900", style: "italic" },
  ],
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

export const naskh = localFont({
  src: [{ path: "../public/fonts/NotoNaskhArabic[wght].woff2", weight: "400 700", style: "normal" }],
  variable: "--font-naskh",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

export const nastaliq = localFont({
  src: [{ path: "../public/fonts/NotoNastaliqUrdu[wght].woff2", weight: "400 700", style: "normal" }],
  variable: "--font-nastaliq",
  display: "optional", // never reflow a page from Naskh metrics to Nastaliq metrics after load
  preload: false,
  adjustFontFallback: false,
});

export const vazirmatn = localFont({
  src: [{ path: "../public/fonts/Vazirmatn[wght].woff2", weight: "100 900", style: "normal" }],
  variable: "--font-vazir",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

export const fontVariables = [inter.variable, newsreader.variable, naskh.variable, nastaliq.variable, vazirmatn.variable].join(" ");
