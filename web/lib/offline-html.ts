import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getTranslations } from "next-intl/server";
import { getCachedSettings, getGlossaryMap, getSitePrefs, type EditionFull, type StoryFull } from "./queries";
import { IMAGE_MAX_VARIANT_BYTES, imagesShown, sortedVariants, storyImage } from "./media";
import { readMediaFile } from "./media-store";
import { DEFAULT_PREFS, IMAGE_PREFS, storedPrefs, type ImagesPref } from "./auth/prefs";
import { dateAt, distinctSourceCount, outletsOf, storiesByGroup } from "./view";
import { dirOf, formatDate, formatHijri, formatTime, localDigits, picked, TZ, type Locale, type Slot, type UrduDigits } from "./urdu";
import type { SavedStory } from "./saved";

/*
 * Editions and the Saved shelf as ONE self-contained HTML file (decision D3): inline CSS, the
 * locale's fonts embedded as base64 woff2, no scripts and no external requests (a CSP meta says so
 * to the browser too), sources as plain links. Built as a string, not with React: route handlers
 * cannot render react-dom/server, and the markup is small. Everything interpolated goes through
 * esc(); links keep only http(s) URLs, since item URLs come from feeds and are untrusted.
 *
 * Publisher images (D6): each story's image is embedded as its 480 px variant (a data: URI), with its
 * credit linking to the cited article, when the reader's images preference allows (the routes decide).
 * A sensitive image sits closed in a <details> ("tap to show", no script needed) and is not printed
 * unless opened. The file stays under FILE_BUDGET_BYTES: past it, only the must-read stories' images go
 * in, as many as fit, and the file says so under its title.
 */

type Translator = Awaited<ReturnType<typeof getTranslations<never>>>;
type Ctx = {
  locale: Locale;
  t: Translator;
  digits?: UrduDigits;
  labels: Map<string, string>;
  site: string;
  siteName: string;
  disclosure: string;
  editorName: string;
  hijriAdjust: number;
  /** Images to embed, by story id (empty: none). */
  images: Map<number, EmbeddedImage>;
  /** Said under the title when some images were left out to keep the file small. */
  imageNote: string;
};

/** A story image as the file embeds it. */
type EmbeddedImage = {
  uri: string;
  w: number;
  h: number;
  color: string;
  alt: string;
  altLang: Locale | null;
  outlet: string;
  /** The cited article or post (http/https): the credit always links there (I3). */
  creditUrl: string;
  graphic: boolean;
  lead: boolean;
};

/**
 * A downloaded file stays under this (UTF-8 bytes); images are what gives way. Decimal, so "under 3 MB"
 * (the file's own note) holds however a device counts megabytes.
 */
export const FILE_BUDGET_BYTES = 3_000_000;
/** Markup around one embedded image (figure, caption, attributes, "tap to show"), besides its texts and link. */
const IMAGE_MARKUP_BYTES = 700;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}
/** An http(s) URL for an href, or null (javascript:, data: and anything unparsable are dropped). */
export function safeHref(u: string | null | undefined): string | null {
  try {
    const url = new URL(String(u ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
export { isEditionDate } from "./view";
/**
 * Every cited item, under its outlet, outlets in outletsOf()'s order (primary first). The site's
 * cards and story page show one headline per outlet; a kept copy (the file, the print sheet) is the
 * record the reader verifies against, so it lists each cited headline and link.
 */
export function sourcesByOutlet(s: StoryFull) {
  const out = outletsOf(s).map((o) => ({ ...o, items: [] as Array<{ id: number; title: string; url: string; lang: string; publishedAt: Date | null }> }));
  const byName = new Map(out.map((o) => [o.name, o]));
  for (const x of [...s.sources].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))) {
    byName.get(x.item.source.name)?.items.push({ id: x.item.id, title: x.item.title, url: x.item.url, lang: x.item.lang, publishedAt: x.item.publishedAt });
  }
  return out;
}
/** lang/dir for a run whose language differs from the page's, as an attribute string. */
function la(textLang: Locale, page: Locale): string {
  return textLang === page ? "" : ` lang="${textLang}" dir="${dirOf(textLang)}"`;
}
const h = (level: number) => `h${Math.min(6, Math.max(1, level))}`;

/* ---- fonts ------------------------------------------------------------------------------------ */

type FontKey = "inter" | "newsreader" | "nastaliq" | "naskh" | "vazir";
// The same OFL files the site serves (public/fonts, subset by scripts/fonts.sh).
const FONTS: Record<FontKey, { file: string; family: string; weight: string }> = {
  inter: { file: "InterVariable.woff2", family: "TB Inter", weight: "100 900" },
  newsreader: { file: "Newsreader[opsz,wght].woff2", family: "TB Newsreader", weight: "200 800" },
  nastaliq: { file: "NotoNastaliqUrdu[wght].woff2", family: "TB Nastaliq", weight: "400 700" },
  naskh: { file: "NotoNaskhArabic[wght].woff2", family: "TB Naskh", weight: "400 700" },
  vazir: { file: "Vazirmatn[wght].woff2", family: "TB Vazir", weight: "100 900" },
};
const URDU_RANGE = "U+0020-0040,U+005B-0060,U+007B-007E,U+00A0,U+00AB,U+00BB,U+0600-06FF,U+0750-077F,U+0870-088E,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFC,U+200C-200F,U+2010-2011";
const fontData = new Map<FontKey, Promise<string>>();

/** base64 of a font file, read once per process. `public/` sits in the working directory in dev and in the standalone build. */
function fontBase64(key: FontKey): Promise<string> {
  let p = fontData.get(key);
  if (!p) {
    p = readFile(path.join(process.cwd(), "public", "fonts", FONTS[key].file)).then((b) => b.toString("base64"));
    p.catch(() => fontData.delete(key));
    fontData.set(key, p);
  }
  return p;
}
async function fontFaces(keys: FontKey[]): Promise<string> {
  const faces = await Promise.all(keys.map(async (k) => {
    const f = FONTS[k];
    const range = k === "nastaliq" || k === "naskh" || k === "vazir" ? `;unicode-range:${URDU_RANGE}` : "";
    // A missing font file must not fail the download: the reader's own fonts take over.
    const data = await fontBase64(k).catch(() => "");
    return data ? `@font-face{font-family:"${f.family}";src:url(data:font/woff2;base64,${data}) format("woff2");font-weight:${f.weight};font-style:normal;font-display:block${range}}` : "";
  }));
  return faces.join("");
}

/* ---- document --------------------------------------------------------------------------------- */

const CSS = `
:root{color-scheme:light dark;--bg:#f7f3ec;--surface:#fffdf9;--surface-2:#f1ebe0;--ink:#1c1917;--ink-2:#57534e;--rule:#d9d1c4;--strong:#1c1917;--accent:#9a2f22;--accent-ink:#fff;--warn:#845a18;--link:#1c1917;
--latin:"TB Inter",system-ui,sans-serif;--latin-display:"TB Newsreader","TB Inter",Georgia,serif;--urdu-body:"TB Nastaliq","TB Naskh","Noto Nastaliq Urdu","Noto Naskh Arabic","TB Inter",serif;--urdu-display:"TB Nastaliq","TB Naskh","Noto Nastaliq Urdu","Noto Naskh Arabic","TB Inter",serif;--urdu-ui:"TB Vazir","TB Naskh","Vazirmatn","Noto Naskh Arabic","TB Inter",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a21;--surface-2:#1f232c;--ink:#ece7de;--ink-2:#b4ada3;--rule:#2a2f3a;--strong:#ece7de;--accent:#e0b46a;--accent-ink:#14110a;--warn:#e0b46a;--link:#ece7de}}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg);color:var(--ink);font-family:var(--latin);-webkit-text-size-adjust:100%}
body{margin:0 auto;max-inline-size:46rem;padding:1.5rem 1rem 4rem;font-size:1.125rem;line-height:1.6;font-synthesis:none}
a{color:var(--link);text-decoration-thickness:1px;text-underline-offset:.16em}
:where([lang]):lang(en){font-family:var(--latin)}
:where([lang]):lang(ur){font-family:var(--urdu-body)}
:lang(ur){letter-spacing:0!important;hyphens:none;text-align:start;overflow-wrap:normal;word-spacing:.04em}
body:lang(ur){font-size:1.35rem;line-height:2.4}
:where(:root:lang(ur) [lang]:lang(en)){font-size:calc(1em/1.2);line-height:1.6}
:where(:root:lang(en) [lang]:lang(ur)){font-size:calc(1em*1.15);line-height:2.1}
h1,h2,h3,h4,h5,h6{margin:0;font-family:var(--latin-display);font-weight:600;line-height:1.2}
:is(h1,h2,h3,h4,h5,h6):lang(ur){font-family:var(--urdu-display);line-height:2;padding-block:.12em;letter-spacing:0}
.ui,.meta,.pill,.label,nav{font-family:var(--latin)}
:is(.ui,.meta,.pill,.label,nav):lang(ur){font-family:var(--urdu-ui);line-height:1.8}
.latin,.latin:lang(ur){font-family:var(--latin);unicode-bidi:isolate}
bdi,[dir=ltr]{unicode-bidi:isolate}
.meta{font-size:.9rem;color:var(--ink-2)}
.mast{border-block-end:3px solid var(--strong);padding-block-end:.75rem;margin-block-end:1.5rem}
.mast .site{margin:0;font-family:var(--latin-display);font-weight:700;font-size:1.6rem}
.mast .site:lang(ur){font-family:var(--urdu-display)}
.mast p{margin:.25rem 0 0}
.doc-title{font-size:2.1rem;margin-block:.5rem .25rem}
.toc{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:.75rem 1rem;margin-block:1.5rem}
.toc ol{margin:.25rem 0;padding-inline-start:1.25rem}
.toc li{margin-block:.2rem}
.toc a{text-decoration:none}
main>.edition:first-child{margin-block-start:0}
main>.edition:first-child>header{border-block-start:0;padding-block-start:0}
.toc .label{font-weight:700;font-size:1rem}
.edition{margin-block-start:2.5rem}
.edition>header{border-block-start:3px solid var(--strong);padding-block-start:.75rem}
.edition>header h1,.edition>header h2,.edition>header h3{font-size:1.9rem}
.group{margin-block-start:2rem}
.group>:is(h2,h3,h4){border-block-start:3px solid var(--strong);padding-block-start:.4rem;font-family:var(--latin);font-weight:700;font-size:1.3rem}
.group>:is(h2,h3,h4):lang(ur),:lang(ur) .group>:is(h2,h3,h4){font-family:var(--urdu-ui)}
.lead{font-family:var(--latin-display);font-size:1.2rem;margin:.5rem 0}
.lead:lang(ur){font-family:var(--urdu-display)}
.story{border-block-start:1px solid var(--rule);padding-block:1.25rem}
.story>:is(h3,h4,h5){font-size:1.5rem;margin-block:.4rem}
.story p{margin:.5rem 0}
.story :is(h4,h5,h6){font-family:var(--latin);font-size:.85rem;font-weight:700;color:var(--accent);margin-block:1rem .25rem}
.story :is(h4,h5,h6):lang(ur){font-family:var(--urdu-ui);font-size:1rem;line-height:1.8;padding:0}
.context{margin:0}
.pill{display:inline-block;padding:.05em .55em;border-radius:999px;font-size:.85rem;font-weight:600;background:var(--surface-2);color:var(--ink-2)}
.pill.accent{background:var(--accent);color:var(--accent-ink)}
.contested{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:.25rem 1rem .5rem}
.contested :is(h4,h5,h6){color:var(--warn)}
.list{margin:.25rem 0;padding-inline-start:1.25rem}
.list li{margin-block:.5rem}
.url{font-family:var(--latin);font-size:.8rem;color:var(--ink-2);overflow-wrap:anywhere;unicode-bidi:isolate}
.post{margin:.5rem 0;background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:.5rem 1rem}
.post p{white-space:pre-line}
.colophon{margin-block-start:3rem;border-block-start:1px solid var(--rule);padding-block-start:1rem}
.story{display:flow-root}
.fig{margin:.75rem 0}
.fig img{display:block;inline-size:100%;block-size:auto;max-block-size:28rem;object-fit:cover;border-radius:4px}
.fig figcaption{margin-block-start:.3rem;overflow-wrap:anywhere}
.fig figcaption:lang(ur){overflow-wrap:normal}
.fig figcaption a{color:inherit}
.fig-thumb{float:inline-end;inline-size:min(40%,14rem);margin:.35rem 0 .6rem;margin-inline-start:1rem}
.fig-thumb img{aspect-ratio:1;max-block-size:none}
details.sensitive{margin:.75rem 0}
details.sensitive>summary{display:inline-flex;align-items:center;min-block-size:44px;padding:.35rem .9rem;border:2px solid var(--strong);border-radius:6px;background:var(--surface);font-weight:600;cursor:pointer}
details.sensitive[open]>summary{margin-block-end:.4rem}
details.sensitive .fig-thumb{float:none;inline-size:min(100%,20rem)}
.note{border-inline-start:3px solid var(--rule);padding-inline-start:.75rem}
@media (prefers-color-scheme:dark){.fig img{filter:brightness(.88)}.fig img:hover{filter:none}}
@media print{.fig img{filter:none}details.sensitive:not([open]){display:none}details.sensitive>summary{display:none}.fig{break-inside:avoid}}
@media print{:root{--bg:#fff;--surface:#fff;--surface-2:#f2f2f2;--ink:#000;--ink-2:#333;--rule:#999;--strong:#000;--link:#000}.story{break-inside:auto}h1,h2,h3,h4,h5,h6{break-after:avoid}}
`;

async function htmlDocument(opts: { ctx: Ctx; title: string; body: string }): Promise<string> {
  const { ctx } = opts;
  const urduText = /[؀-ۿ]/.test(opts.body);
  // Urdu files: Nastaliq (body and headings), Vazirmatn (labels), Inter (Latin names). English files:
  // Inter and Newsreader, plus Naskh, compact and clear, only when an Urdu run (a quoted post) appears.
  const keys: FontKey[] = ctx.locale === "ur" ? ["nastaliq", "vazir", "inter"] : urduText ? ["inter", "newsreader", "naskh"] : ["inter", "newsreader"];
  const faces = await fontFaces(keys);
  return `<!doctype html>
<html lang="${ctx.locale}" dir="${dirOf(ctx.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(opts.title)}</title>
<style>${faces}${CSS}</style>
</head>
<body>
${opts.body}
</body>
</html>
`;
}

async function context(locale: Locale): Promise<Ctx> {
  const [t, prefs, settings, labels] = await Promise.all([
    getTranslations({ locale }), getSitePrefs(), getCachedSettings(), locale === "ur" ? getGlossaryMap() : Promise.resolve(new Map<string, string>()),
  ]);
  const configured = locale === "ur" ? settings.site_name_ur : settings.site_name_en;
  return {
    locale, t, labels,
    digits: locale === "ur" ? prefs.digitsUr : undefined,
    site: (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    siteName: typeof configured === "string" && configured.trim() ? configured.trim() : t("site.name"),
    disclosure: (locale === "ur" ? prefs.disclosureUr : prefs.disclosureEn) || t("site.disclosure"),
    editorName: prefs.editorName,
    hijriAdjust: prefs.hijriAdjust,
    images: new Map(),
    imageNote: "",
  };
}

/* ---- images ----------------------------------------------------------------------------------- */

type ImageStory = Pick<StoryFull, "id" | "tag" | "image" | "imageHiddenAt" | "sources" | "posts">;

/**
 * Whether a download (or the offline manifest) includes images: the reader's images preference ("off": never;
 * "auto": unless the request says Save-Data: on). The device's own choice comes as ?images=auto|on|off (the
 * page sends what <html data-images> says, so a choice the account never received still counts); without it,
 * the account's stored one.
 */
export function wantsImages(accountPrefs: unknown, req: Request): boolean {
  const asked = new URL(req.url).searchParams.get("images");
  const device = (IMAGE_PREFS as readonly string[]).includes(asked ?? "") ? (asked as ImagesPref) : null;
  const pref = device ?? storedPrefs(accountPrefs).images ?? DEFAULT_PREFS.images;
  return imagesShown(pref, req.headers.get("save-data")?.trim().toLowerCase() === "on");
}

/** An image the file may embed, before its bytes are read: `bytes` is the stored variant's size (planning only). */
type Candidate = { storyId: number; file: string; bytes: number; img: Omit<EmbeddedImage, "uri"> };

const DATA_URI_PREFIX = "data:image/webp;base64,";

/**
 * The image of each story, in the order the file shows them (a story shown twice is listed twice), as its
 * narrowest (480 px) variant. Stories with no image, an editor-hidden one, or one whose credit cannot link
 * to an item or post the story cites (I1/I3) are left out. Nothing is read from disk here.
 */
function imageCandidates(ctx: Ctx, list: ImageStory[]): Candidate[] {
  const out: Candidate[] = [];
  for (const s of list) {
    const img = storyImage(s);
    const v = img ? sortedVariants(img)[0] : undefined;
    const creditUrl = safeHref(img?.creditUrl);
    if (!img || !v || !creditUrl) continue;
    const outlet = ctx.labels.get(img.credit.toLowerCase()) ?? img.credit;
    const altLang: Locale = img.alt ? (img.itemLang?.toLowerCase().startsWith("ur") ? "ur" : "en") : ctx.locale;
    out.push({
      storyId: s.id,
      file: v.file,
      // The size the server stored; an odd value plans for the largest variant it accepts.
      bytes: Number.isSafeInteger(v.bytes) && v.bytes > 0 ? v.bytes : IMAGE_MAX_VARIANT_BYTES,
      img: {
        w: v.w, h: v.h,
        color: /^#[0-9a-f]{6}$/i.test(img.color) ? img.color : "#888888",
        alt: img.alt ?? ctx.t("images.altFallback", { outlet }),
        altLang: altLang === ctx.locale ? null : altLang,
        outlet,
        creditUrl,
        graphic: img.graphic,
        lead: s.tag === "must-read",
      },
    });
  }
  return out;
}

/**
 * What one embedded image adds to the file: its data: URI (base64), its alt text and credit link (escaping
 * can only grow them, hence the margin) and the markup around them.
 */
function imageCost(c: Candidate): number {
  const text = Buffer.byteLength(c.img.alt, "utf8") + Buffer.byteLength(c.img.creditUrl, "utf8") + Buffer.byteLength(c.img.outlet, "utf8");
  return DATA_URI_PREFIX.length + 4 * Math.ceil(c.bytes / 3) + Math.ceil(text * 1.2) + IMAGE_MARKUP_BYTES;
}

/**
 * Build the file, with images when `withImages`: all of them if the file stays under FILE_BUDGET_BYTES,
 * else the must-read stories' images while they fit (with a note saying so), else none (also said).
 * The budget is planned from the stored sizes, so only the files that go in are read.
 */
async function withImagesWithinBudget(ctx: Ctx, list: ImageStory[], withImages: boolean, build: () => Promise<string>): Promise<string> {
  const plain = await build();
  if (!withImages) return plain;
  const candidates = imageCandidates(ctx, list);
  if (!candidates.length) return plain;
  const base = Buffer.byteLength(plain, "utf8");
  const total = candidates.reduce((n, c) => n + imageCost(c), 0);
  let chosen: Candidate[];
  if (base + total <= FILE_BUDGET_BYTES) {
    chosen = candidates;
  } else {
    // Only the must-read stories' images, in the file's order, while they fit (a repeated story counts each time).
    const leads = candidates.filter((c) => c.img.lead);
    const ids = new Set<number>();
    let used = base;
    for (const id of new Set(leads.map((c) => c.storyId))) {
      const need = leads.filter((c) => c.storyId === id).reduce((n, c) => n + imageCost(c), 0);
      if (used + need <= FILE_BUDGET_BYTES) { ids.add(id); used += need; }
    }
    chosen = leads.filter((c) => ids.has(c.storyId));
    const everyLead = ids.size > 0 && ids.size === new Set(leads.map((c) => c.storyId)).size;
    // The note itself is a few hundred bytes, inside IMAGE_MARKUP_BYTES' slack.
    ctx.imageNote = ctx.t(!ids.size ? "images.fileNone" : everyLead ? "images.fileLeadOnly" : "images.fileSomeOnly");
  }
  const files = new Map<string, Promise<Buffer | null>>();
  for (const c of chosen) if (!files.has(c.file)) files.set(c.file, readMediaFile(c.file));
  const images = new Map<number, EmbeddedImage>();
  for (const c of chosen) {
    if (images.has(c.storyId)) continue;
    const data = await files.get(c.file)!;
    // A missing file is left out; so is one past the upload limit (the budget was planned from the rows).
    if (!data || data.length > IMAGE_MAX_VARIANT_BYTES) continue;
    images.set(c.storyId, { ...c.img, uri: `${DATA_URI_PREFIX}${data.toString("base64")}` });
  }
  ctx.images = images;
  return build();
}

/** A story's embedded image: under the headline, large for must-read stories, else beside the text. */
function figure(ctx: Ctx, img: EmbeddedImage): string {
  const latin = !/[؀-ۿ]/.test(img.outlet);
  const name = `<span${latin ? ` class="latin" dir="ltr"` : ""}>${esc(img.outlet)}</span>`;
  const credit = ctx.t.markup("images.credit", {
    outlet: esc(img.outlet),
    o: () => `<a href="${esc(img.creditUrl)}">${name}</a>`,
  });
  const alt = `alt="${esc(img.alt)}"${img.altLang ? ` lang="${img.altLang}" dir="${dirOf(img.altLang)}"` : ""}`;
  const fig = `<figure class="fig ${img.lead ? "fig-lead" : "fig-thumb"}"><img src="${img.uri}" width="${img.w}" height="${img.h}" ${alt} style="background:${img.color}">`
    + `<figcaption class="meta">${credit}</figcaption></figure>`;
  return img.graphic ? `<details class="sensitive"><summary class="ui">${esc(ctx.t("images.sensitive"))}</summary>${fig}</details>` : fig;
}

/* ---- pieces ----------------------------------------------------------------------------------- */

function masthead(ctx: Ctx, extra: string): string {
  const note = ctx.imageNote ? `<p class="meta note">${esc(ctx.imageNote)}</p>` : "";
  return `<header class="mast"><p class="site">${esc(ctx.siteName)}</p><p class="meta">${esc(ctx.t("site.tagline"))}</p>${extra}${note}</header>`;
}

function colophon(ctx: Ctx, onlineUrl: string): string {
  const now = new Date();
  const when = `${formatDate(now, ctx.locale, { dateStyle: "long" }, ctx.digits)} · ${formatTime(now, ctx.locale, ctx.digits)}`;
  const reviewed = ctx.editorName ? ` ${esc(ctx.t("edition.reviewedBy", { name: ctx.editorName }))}.` : "";
  return `<footer class="colophon meta"><p>${esc(ctx.disclosure)}${reviewed}</p>`
    + `<p>${esc(ctx.t("download.downloadedOn", { date: when }))}</p>`
    + `<p>${esc(ctx.t("download.onlineAt"))} <a href="${esc(onlineUrl)}" class="url" dir="ltr">${esc(onlineUrl)}</a></p></footer>`;
}

function outletName(ctx: Ctx, name: string): string {
  const ur = ctx.labels.get(name.toLowerCase());
  return ur ? `<b>${esc(ur)}</b>` : `<b class="latin" dir="ltr">${esc(name)}</b>`;
}

function link(url: string | null | undefined, text: string, attrs = ""): string {
  const href = safeHref(url);
  return href ? `<a href="${esc(href)}"${attrs}>${text}</a>` : `<span${attrs}>${text}</span>`;
}

function story(ctx: Ctx, s: StoryFull, level: number, anchor: string, contextLine = ""): string {
  const { t, locale: l, digits } = ctx;
  const num = (x: string) => localDigits(x, l, digits);
  const outlets = outletsOf(s);
  const itemById = new Map(s.sources.map((x) => [x.item.id, x.item]));
  const title = picked(s, "title", l), summary = picked(s, "summary", l), why = picked(s, "why", l), contested = picked(s, "contested", l);
  const sub = h(level + 1);
  const cov = s.coverage ?? (outlets.length > 1 ? "broad" : "single-source");
  const pills = [
    s.tag === "must-read" ? `<span class="pill accent">${esc(t("tags.must-read"))}</span>` : "",
    s.thread ? `<span class="pill">${esc(t("story.thread"))}</span>` : "",
    s.qaStatus === "flagged" ? `<span class="pill">${esc(t("qa.flagged"))}</span>` : "",
    `<span>${esc(t(`coverage.${cov}`))}</span>`,
    `<span>${esc(num(t("story.sources", { count: outlets.length })))}</span>`,
  ].filter(Boolean).join(" · ");
  const parts: string[] = [];
  parts.push(`<article class="story" id="${anchor}">`);
  if (contextLine) parts.push(`<p class="context meta">${contextLine}</p>`);
  parts.push(`<p class="meta">${pills}</p>`);
  parts.push(`<${h(level)}${la(title.lang, l)}>${esc(title.text)}</${h(level)}>`);
  const img = ctx.images.get(s.id);
  if (img) parts.push(figure(ctx, img));
  parts.push(`<p${la(summary.lang, l)}>${esc(summary.text)}</p>`);
  if (why.text) parts.push(`<p><b>${esc(t("story.whyItMatters"))}:</b> <span${la(why.lang, l)}>${esc(why.text)}</span></p>`);
  if (contested.text) parts.push(`<div class="contested"><${sub}>${esc(t("story.contested"))}</${sub}><p${la(contested.lang, l)}>${esc(contested.text)}</p></div>`);
  if (s.angles.length) {
    parts.push(`<${sub}>${esc(t("story.angles"))}</${sub}><ul class="list">`);
    for (const a of s.angles) {
      const item = itemById.get(a.itemId);
      const note = picked(a, "note", l);
      parts.push(`<li>${item ? outletName(ctx, item.source.name) : "—"}${item?.source.perspective ? ` <span class="meta">·</span> <span class="meta latin" dir="ltr">${esc(item.source.perspective)}</span>` : ""}<br><span${la(note.lang, l)}>${esc(note.text)}</span></li>`);
    }
    parts.push(`</ul>`);
  }
  parts.push(`<${sub}>${esc(num(t("story.sources", { count: outlets.length })))}</${sub}><ol class="list">`);
  for (const o of sourcesByOutlet(s)) {
    parts.push(`<li>${outletName(ctx, o.name)}${o.perspective ? ` <span class="meta latin" dir="ltr">${esc(o.perspective)}</span>` : ""}`);
    for (const it of o.items) {
      const href = safeHref(it.url);
      const when = it.publishedAt ? `<br><span class="meta">${esc(formatDate(it.publishedAt, l, { dateStyle: "medium" }, digits))} · ${esc(formatTime(it.publishedAt, l, digits))}</span>` : "";
      parts.push(`<br><span class="meta">${esc(t("story.originalHeadline"))}:</span> ${link(it.url, esc(it.title), la(it.lang === "ur" ? "ur" : "en", l))}`
        + (href ? `<br><span class="url" dir="ltr">${esc(href)}</span>` : "") + when);
    }
    parts.push(`</li>`);
  }
  parts.push(`</ol>`);
  if (s.posts.length) {
    parts.push(`<${sub}>${esc(t("story.posts"))}</${sub}>`);
    for (const { post: p } of s.posts) {
      const ur = /[؀-ۿ]/.test(p.text);
      parts.push(`<blockquote class="post"><p${la(ur ? "ur" : "en", l)}>${esc(p.text)}</p><p class="meta"><bdi>${esc(p.authorName || p.authorHandle)}</bdi> <span class="latin" dir="ltr">@${esc(p.authorHandle)}</span> · ${esc(formatDate(p.postedAt, l, { dateStyle: "medium" }, digits))} · ${esc(formatTime(p.postedAt, l, digits))} · ${link(p.url, esc(t("story.asPosted")))}</p></blockquote>`);
    }
  }
  if (s.corrections.length) {
    parts.push(`<${sub}>${esc(t("story.corrections"))}</${sub}><ul class="list">`);
    for (const c of s.corrections) {
      const text = picked(c, "text", l);
      parts.push(`<li><span class="meta">${esc(formatDate(c.createdAt, l, { dateStyle: "medium" }, digits))}</span> · <span${la(text.lang, l)}>${esc(text.text)}</span></li>`);
    }
    parts.push(`</ul>`);
  }
  const permalink = `${ctx.site}/${l}/story/${s.id}`;
  parts.push(`<p class="meta">${esc(ctx.t("download.onlineAt"))} <a href="${esc(permalink)}" class="url" dir="ltr">${esc(permalink)}</a></p>`);
  parts.push(`</article>`);
  return parts.join("\n");
}

/** Title and date line of an edition, e.g. "Evening edition" and "Wednesday, 23 September 2026 · …". */
function editionTitle(ctx: Ctx, ed: EditionFull) {
  const day = dateAt(ed.date);
  return {
    title: ctx.t(`slots.${ed.slot}Long`),
    date: formatDate(day, ctx.locale, { dateStyle: "full" }, ctx.digits),
    hijri: `${formatHijri(day, ctx.locale, ctx.hijriAdjust, ctx.digits)} (${ctx.t("time.hijriApprox")})`,
  };
}

/** One edition: header, contents, then every group's lead and stories in the site's order. */
function edition(ctx: Ctx, ed: EditionFull, level: number, idPrefix: string): string {
  const { t, locale: l, digits } = ctx;
  const et = editionTitle(ctx, ed);
  const byGroup = storiesByGroup(ed);
  const sources = distinctSourceCount(ed);
  const groups = ed.groups.filter((g) => (byGroup.get(g.groupId)?.length ?? 0) > 0 || g.leadEn);
  const gname = (g: EditionFull["groups"][number]) => (l === "ur" ? g.group.nameUr : g.group.nameEn);
  const out: string[] = [];
  out.push(`<section class="edition" id="${idPrefix}e-${ed.id}" aria-labelledby="${idPrefix}e-${ed.id}-h"><header>`);
  out.push(`<p class="meta"><time datetime="${esc(ed.date)}">${esc(et.date)}</time> · ${esc(et.hijri)}</p>`);
  out.push(`<${h(level)} id="${idPrefix}e-${ed.id}-h">${esc(et.title)}</${h(level)}>`);
  const compiled = ed.publishedAt ? localDigits(t("edition.compiledAt", { time: formatTime(ed.publishedAt, l, digits), count: sources }), l, digits) : "";
  const reviewed = ctx.editorName ? t("edition.reviewedBy", { name: ctx.editorName }) : "";
  if (compiled || reviewed) out.push(`<p class="meta">${esc([compiled, reviewed].filter(Boolean).join(" · "))}</p>`);
  out.push(`</header>`);
  // Contents: group names, then each story's headline, linking inside the file.
  out.push(`<nav class="toc" aria-label="${esc(t("download.contents"))}"><p class="label">${esc(t("download.contents"))}</p><ol>`);
  for (const g of groups) {
    const list = byGroup.get(g.groupId) ?? [];
    out.push(`<li><a href="#${idPrefix}g-${ed.id}-${esc(g.group.slug)}">${esc(gname(g))}</a>`);
    if (list.length) out.push(`<ol>${list.map((s) => { const tt = picked(s, "title", l); return `<li><a href="#${idPrefix}s-${s.id}"${la(tt.lang, l)}>${esc(tt.text)}</a></li>`; }).join("")}</ol>`);
    out.push(`</li>`);
  }
  out.push(`</ol></nav>`);
  for (const g of groups) {
    const lead = picked(g, "lead", l);
    out.push(`<section class="group" id="${idPrefix}g-${ed.id}-${esc(g.group.slug)}"><${h(level + 1)}>${esc(gname(g))}</${h(level + 1)}>`);
    if (lead.text) out.push(`<p class="lead"${la(lead.lang, l)}>${esc(lead.text)}</p>`);
    for (const s of byGroup.get(g.groupId) ?? []) out.push(story(ctx, s, level + 2, `${idPrefix}s-${s.id}`));
    out.push(`</section>`);
  }
  out.push(`</section>`);
  return out.join("\n");
}

/* ---- the two files ---------------------------------------------------------------------------- */

/** Download name: tabayyun-2026-09-23-shaam-ur.html */
export function editionFileName(date: string, slot: Slot, locale: Locale) {
  return `tabayyun-${date}-${slot}-${locale}.html`;
}
/** Download name of the shelf, dated in Pakistan time: tabayyun-saved-2026-09-28-en.html */
export function shelfFileName(locale: Locale, now = new Date()) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return `tabayyun-saved-${day}-${locale}.html`;
}

/**
 * One published edition as a self-contained HTML document. `images`: embed the stories' images (the
 * reader's images preference allows them; see the download route).
 */
export async function renderEditionFile(ed: EditionFull, locale: Locale, opts: { images?: boolean } = {}): Promise<string> {
  const ctx = await context(locale);
  const et = editionTitle(ctx, ed);
  const build = () => htmlDocument({
    ctx,
    title: `${et.title} · ${formatDate(dateAt(ed.date), locale, { dateStyle: "long" }, ctx.digits)} · ${ctx.siteName}`,
    body: [
      masthead(ctx, ""),
      `<main>${edition(ctx, ed, 1, "")}</main>`,
      colophon(ctx, `${ctx.site}/${locale}/${ed.date}/${ed.slot}`),
    ].join("\n"),
  });
  // Stories in the order the file shows them (group by group), so a budget keeps the first ones.
  const byGroup = storiesByGroup(ed);
  const ordered = ed.groups.flatMap((g) => byGroup.get(g.groupId) ?? []);
  return withImagesWithinBudget(ctx, ordered, !!opts.images, build);
}

/** The reader's whole Saved shelf (saved editions in full, then saved stories) as one document; `images` as renderEditionFile. */
export async function renderShelfFile(shelf: { editions: Array<{ savedAt: Date; ed: EditionFull }>; stories: SavedStory[] }, locale: Locale, opts: { images?: boolean } = {}): Promise<string> {
  const ctx = await context(locale);
  const ordered: ImageStory[] = [
    ...shelf.editions.flatMap(({ ed }) => { const byGroup = storiesByGroup(ed); return ed.groups.flatMap((g) => byGroup.get(g.groupId) ?? []); }),
    ...shelf.stories.map((s) => s.story),
  ];
  return withImagesWithinBudget(ctx, ordered, !!opts.images, () => shelfDocument(ctx, shelf, locale));
}

async function shelfDocument(ctx: Ctx, shelf: { editions: Array<{ savedAt: Date; ed: EditionFull }>; stories: SavedStory[] }, locale: Locale): Promise<string> {
  const { t, digits } = ctx;
  const l = locale;
  const num = (x: string) => localDigits(x, l, digits);
  const title = t("download.shelfTitle");
  const out: string[] = [];
  const edLabel = (ed: { date: string; slot: string }) => `${t(`slots.${ed.slot as Slot}Long`)} · ${formatDate(dateAt(ed.date), l, { dateStyle: "long" }, digits)}`;
  out.push(masthead(ctx, `<h1 class="doc-title">${esc(title)}</h1><p class="meta">${esc(num(t("saved.counts", { stories: shelf.stories.length, editions: shelf.editions.length })))}</p>`));
  out.push(`<main>`);
  if (!shelf.editions.length && !shelf.stories.length) out.push(`<p>${esc(t("saved.emptyTitle"))}</p>`);
  // Contents first: the file can be long, and in-file links work offline.
  if (shelf.editions.length || shelf.stories.length) {
    out.push(`<nav class="toc" aria-label="${esc(t("download.contents"))}"><p class="label">${esc(t("download.contents"))}</p>`);
    if (shelf.editions.length) out.push(`<p class="label">${esc(t("saved.editions"))}</p><ol>${shelf.editions.map(({ ed }) => `<li><a href="#e-${ed.id}">${esc(edLabel(ed))}</a></li>`).join("")}</ol>`);
    if (shelf.stories.length) out.push(`<p class="label">${esc(t("saved.stories"))}</p><ol>${shelf.stories.map(({ story: s }) => { const tt = picked(s, "title", l); return `<li><a href="#ss-${s.id}"${la(tt.lang, l)}>${esc(tt.text)}</a></li>`; }).join("")}</ol>`);
    out.push(`</nav>`);
  }
  if (shelf.editions.length) {
    out.push(`<section aria-labelledby="saved-editions"><h2 id="saved-editions">${esc(t("saved.editions"))}</h2>`);
    for (const { ed } of shelf.editions) out.push(edition(ctx, ed, 3, ""));
    out.push(`</section>`);
  }
  if (shelf.stories.length) {
    out.push(`<section aria-labelledby="saved-stories" style="margin-block-start:3rem"><h2 id="saved-stories">${esc(t("saved.stories"))}</h2>`);
    for (const { story: s, savedAt } of shelf.stories) {
      const group = l === "ur" ? s.group.nameUr : s.group.nameEn;
      const line = `${esc(edLabel(s.edition))} · ${esc(group)} · ${esc(t("saved.savedOn", { date: formatDate(savedAt, l, { dateStyle: "medium" }, digits) }))}`;
      out.push(story(ctx, s, 3, `ss-${s.id}`, line));
    }
    out.push(`</section>`);
  }
  out.push(`</main>`);
  out.push(colophon(ctx, `${ctx.site}/${l}/saved`));
  return htmlDocument({ ctx, title: `${title} · ${ctx.siteName}`, body: out.join("\n") });
}
