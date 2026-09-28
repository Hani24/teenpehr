import type { EditionFull, StoryFull } from "./queries";
import type { Locale } from "./urdu";
import { CONTRASTS, DEFAULT_PREFS, DIGIT_STYLES, IMAGE_PREFS, PALETTES, READING_MODES, TEXT_SIZES, storedPrefs, type Palette, type Prefs, type PrefsPatch, type ReadingMode } from "./auth/prefs";

export type Outlet = { name: string; perspective: string; url: string; title: string; lang: string; isPrimary: boolean; publishedAt: Date | null };

/** Unique outlets behind a story, primary first. */
export function outletsOf(story: StoryFull): Outlet[] {
  const seen = new Map<string, Outlet>();
  const sorted = [...story.sources].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  for (const s of sorted) {
    const name = s.item.source.name;
    if (!seen.has(name)) seen.set(name, { name, perspective: s.item.source.perspective, url: s.item.url, title: s.item.title, lang: s.item.lang, isPrimary: s.isPrimary, publishedAt: s.item.publishedAt });
  }
  return [...seen.values()];
}

export function primarySource(story: StoryFull) {
  return story.sources.find((s) => s.isPrimary) ?? story.sources[0];
}

/** Rough reading time from the localized text of every story. */
export function readingMinutes(ed: EditionFull, locale: Locale): number {
  const words = ed.stories.reduce((n, s) => n + (locale === "ur" ? (s.summaryUr || s.summaryEn) : s.summaryEn).split(/\s+/).length + 12, 0);
  return Math.max(1, Math.round(words / (locale === "ur" ? 160 : 220)));
}

/** Up to five must-reads across groups, in group order, for the "need to know" block. */
export function needToKnow(ed: EditionFull, max = 5): StoryFull[] {
  const order = new Map(ed.groups.map((g, i) => [g.groupId, i]));
  return ed.stories.filter((s) => s.tag === "must-read").sort((a, b) => (order.get(a.groupId) ?? 99) - (order.get(b.groupId) ?? 99) || a.order - b.order).slice(0, max);
}

export function storiesByGroup(ed: EditionFull) {
  const map = new Map<number, StoryFull[]>();
  for (const s of ed.stories) map.set(s.groupId, [...(map.get(s.groupId) ?? []), s]);
  for (const list of map.values()) list.sort((a, b) => a.order - b.order);
  return map;
}

export function distinctSourceCount(ed: EditionFull): number {
  return new Set(ed.stories.flatMap((s) => s.sources.map((x) => x.item.source.name))).size;
}

export function editionPath(date: string, slot: string) { return `/${date}/${slot}`; }
export function dateAt(date: string) { return new Date(`${date}T12:00:00+05:00`); }

/**
 * A real calendar date as YYYY-MM-DD that Postgres accepts: 2026-02-31 (which Date.parse rolls over
 * to March) and year 0000 would make the edition query throw, a 500 instead of a 404.
 */
export function isEditionDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < "0001-01-01") return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}
/** A story id from a URL segment: plain digits within Postgres integer range, else null (a 404, not a 500). */
export function storyIdFrom(segment: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(segment)) return null;
  const n = Number(segment);
  return n <= 2_147_483_647 ? n : null;
}

/*
 * Reader palettes and the Wazeh reading mode (decision D4 in docs/PLAN.md). Two independent
 * switches on <html>: data-theme (the palette, colours only) and data-mode ("wazeh": larger text,
 * one column, bigger buttons), plus data-size, data-contrast, data-nastaliq, data-digits and
 * data-images (auto|on|off, publisher photos). The values are a reader's Prefs (lib/auth/prefs.ts),
 * kept in localStorage for an instant boot and, when signed in, in users.prefs so they follow the
 * reader across devices. The boot script also sets data-save-data="on" when the device asks to save
 * data (navigator.connection.saveData), which turns images="auto" off (lib/media.ts imagesShown).
 *
 * Adding a palette: its id in PALETTES (lib/auth/prefs.ts), a token block and a high-contrast block
 * in app/globals.css, an entry in PALETTE_DEFS below and `themes.<id>` / `themes.<id>Hint` in
 * messages/*.json; then run `node scripts/contrast-check.mjs`, which also checks `bg` here.
 * "system" has no tokens of its own: CSS makes it Classic, or Night on a device that prefers dark.
 * `bg` is the palette's --bg, used for the browser bar and the installed app's splash screen.
 */
export type PaletteDef = { id: Palette; scheme: "light" | "dark" | "auto"; bg: string };
const PALETTE_DEFS = {
  system: { scheme: "auto", bg: "#f7f3ec" },
  classic: { scheme: "light", bg: "#f7f3ec" },
  night: { scheme: "dark", bg: "#0f1115" },
  kaghaz: { scheme: "light", bg: "#f3e8d0" },
  sabz: { scheme: "light", bg: "#ebf2e8" },
  chandni: { scheme: "dark", bg: "#1a212b" },
  shab: { scheme: "dark", bg: "#000000" },
} as const satisfies Record<Palette, Omit<PaletteDef, "id">>;
export const THEMES: readonly PaletteDef[] = PALETTES.map((id) => ({ id, ...PALETTE_DEFS[id] }));
/** What "system" shows on a light and on a dark device. */
export const SYSTEM_LIGHT = "classic" satisfies Palette;
export const SYSTEM_DARK = "night" satisfies Palette;
/** The palette when Settings names none: follow the device. */
export const BASE_THEME: Palette = "system";
export function themeDef(id: string | null | undefined): PaletteDef | undefined { return THEMES.find((t) => t.id === id); }
export function isPalette(x: unknown): x is Palette { return typeof x === "string" && (PALETTES as readonly string[]).includes(x); }
export function paletteBg(id: Palette): string { return PALETTE_DEFS[id].bg; }

/** Reading modes (data-mode). Wazeh (واضح, clear): larger text, one column, bigger buttons. */
export const MODES: readonly { id: ReadingMode }[] = READING_MODES.map((id) => ({ id }));
export function isMode(x: unknown): x is ReadingMode { return typeof x === "string" && (READING_MODES as readonly string[]).includes(x); }
/** The modes a group can be hidden in (groups.hidden_in_themes holds these ids). */
export const HIDE_IN_MODES = ["wazeh"] as const satisfies readonly ReadingMode[];
/** The theme id Wazeh had when it was a theme; still found in old localStorage and settings rows. */
const LEGACY_WAZEH_THEME = "buzurg";

/**
 * Groups the admin hides in a mode (groups.hidden_in_themes). The mode is chosen on the device, so
 * hidden sections are rendered with `data-hidden-in="<ids>"` and this CSS hides them.
 */
export function hiddenGroupCss(): string {
  return HIDE_IN_MODES.map((m) => `:root[data-mode="${m}"] [data-hidden-in~="${m}"]{display:none}`).join("");
}

/**
 * The site's defaults from Settings: default_theme (a palette), default_mode and digits_ur. A
 * default_theme of "wazeh" (or the older id) is from when Wazeh was a theme: Wazeh on the base palette.
 */
export function siteThemeDefaults(s: Record<string, unknown>): Prefs {
  const theme = typeof s.default_theme === "string" ? s.default_theme : "";
  const wasMode = theme === "wazeh" || theme === LEGACY_WAZEH_THEME;
  return {
    ...DEFAULT_PREFS,
    palette: themeDef(theme)?.id ?? BASE_THEME,
    mode: isMode(s.default_mode) ? s.default_mode : wasMode ? "wazeh" : "standard",
    digits: s.digits_ur === "arabext" ? "arabext" : "latn",
  };
}

/** The <html> attributes for a set of preferences; the server render, the boot script and the controls all set these. */
export function themeAttrs(p: Prefs) {
  return { "data-theme": p.palette, "data-mode": p.mode, "data-size": p.size, "data-contrast": p.contrast, "data-nastaliq": p.nastaliq ? "on" : "off", "data-digits": p.digits, "data-images": p.images };
}

/** localStorage keys per preference (the tp-* names predate the rename and stay). */
export const PREF_STORAGE = { palette: "tp-theme", mode: "tp-mode", size: "tp-size", contrast: "tp-contrast", nastaliq: "tp-nastaliq", digits: "tp-digits", images: "tp-images" } as const satisfies Record<keyof Prefs, string>;
/** localStorage key of the last account preferences this device saw, and when the server read them. */
export const ACCOUNT_SNAPSHOT_KEY = "tp-account";
export const PREF_FIELDS = Object.keys(PREF_STORAGE) as (keyof Prefs)[];
/** `u`: the account the snapshot was taken from (absent in snapshots from before accounts were recorded). */
export type AccountSnapshot = { p: PrefsPatch; at: number; u?: number };
/**
 * The snapshot, if it was taken from this account. On a shared device another account's snapshot
 * says nothing about this one: it is ignored (the account's own choices win) and, unlike a device
 * that has never seen an account, this device's choices are not pushed into the account either.
 */
function snapshotFor(snapshot: AccountSnapshot | null, uid: number | null): { own: AccountSnapshot | null; foreign: boolean } {
  if (!snapshot) return { own: null, foreign: false };
  return snapshot.u !== undefined && snapshot.u === uid ? { own: snapshot, foreign: false } : { own: null, foreign: true };
}

/** This device's stored choices. Old values: theme "buzurg" is Classic in Wazeh; "" was an explicit off. */
export function decodeLocalPrefs(get: (key: string) => string | null): PrefsPatch {
  const theme = get(PREF_STORAGE.palette), mode = get(PREF_STORAGE.mode), contrast = get(PREF_STORAGE.contrast), nastaliq = get(PREF_STORAGE.nastaliq);
  const legacy = theme === LEGACY_WAZEH_THEME;
  return storedPrefs({
    palette: legacy ? "classic" : theme,
    mode: isMode(mode) ? mode : legacy ? "wazeh" : null,
    size: get(PREF_STORAGE.size),
    contrast: contrast === "" ? "normal" : contrast,
    nastaliq: nastaliq === "1" ? true : nastaliq === "0" || nastaliq === "" ? false : null,
    digits: get(PREF_STORAGE.digits),
    images: get(PREF_STORAGE.images),
  });
}
export function encodeLocalPref<K extends keyof Prefs>(field: K, value: Prefs[K]): string {
  return typeof value === "boolean" ? (value ? "1" : "0") : String(value);
}

/**
 * The preferences to apply, field by field (the boot script below follows the same rule):
 * 1. the account's value, if it changed since this device last saw the account (another device
 *    changed it, or this device has never seen this account) and this page's copy is newer than that;
 * 2. else this device's choice; 3. else the account's; 4. else, for contrast, high when the device
 *    asks for more contrast; 5. else the site default.
 * `account` is null when signed out. A page served from the offline cache carries an old copy of the
 * account (older `at`), which never overrides.
 */
export function resolvePrefs(o: { site: Prefs; account: PrefsPatch | null; uid: number | null; at: number; local: PrefsPatch; snapshot: AccountSnapshot | null; moreContrast: boolean }): Prefs {
  const snap = snapshotFor(o.snapshot, o.uid).own;
  const fresh = !!o.account && !(snap && snap.at >= o.at);
  const base = snap?.p ?? {};
  const pick = <K extends keyof Prefs>(f: K): Prefs[K] => {
    const a = o.account?.[f] as Prefs[K] | undefined;
    if (fresh && a !== undefined && a !== base[f]) return a;
    if (o.local[f] !== undefined) return o.local[f] as Prefs[K];
    if (a !== undefined) return a;
    if (f === "contrast" && o.moreContrast) return "high" as Prefs[K];
    return o.site[f];
  };
  return { palette: pick("palette"), mode: pick("mode"), size: pick("size"), contrast: pick("contrast"), nastaliq: pick("nastaliq"), digits: pick("digits"), images: pick("images") };
}

/**
 * Bring this device and the account together after a page load (signed in, with a fresh copy of the
 * account): a field the account changed since the snapshot is adopted here; a field chosen here that
 * the account lacks, or that changed here while the save could not reach the server, is pushed.
 * Null when there is nothing to learn from this page's copy (signed out, or an old copy).
 */
export function reconcilePrefs(o: { account: PrefsPatch | null; uid: number | null; at: number; local: PrefsPatch; snapshot: AccountSnapshot | null }): { adopt: PrefsPatch; push: PrefsPatch } | null {
  const { own, foreign } = snapshotFor(o.snapshot, o.uid);
  if (!o.account || (own && own.at >= o.at)) return null;
  const base = own?.p ?? {};
  const adopt: Record<string, unknown> = {}, push: Record<string, unknown> = {};
  for (const f of PREF_FIELDS) {
    const a = o.account[f], b = base[f], l = o.local[f];
    if (a === undefined) { if (l !== undefined && !foreign) push[f] = l; }
    else if (a !== b) { if (l !== a) adopt[f] = a; }
    else if (l !== undefined && l !== a) push[f] = l;
  }
  return { adopt: adopt as PrefsPatch, push: push as PrefsPatch };
}

/** What the server knows when rendering <html>: the site defaults, the account's choices and id (null when signed out) and when it read them. */
export type ThemeBoot = { site: Prefs; account: PrefsPatch | null; uid: number | null; at: number };
/** The account's choices over the site defaults: what the server renders on <html>. */
export function renderedPrefs(b: ThemeBoot): Prefs { return { ...b.site, ...(b.account ?? {}) }; }

/**
 * Runs in <head> before paint: resolvePrefs() above on this device's storage, then the <html>
 * attributes, so no palette or mode flashes. Hand-written ES5 so it runs as-is in any browser.
 */
export function bootScript(b: ThemeBoot): string {
  const cfg = JSON.stringify({
    site: b.site, account: b.account, uid: b.uid, at: b.at, keys: PREF_STORAGE, snap: ACCOUNT_SNAPSHOT_KEY, legacy: LEGACY_WAZEH_THEME,
    ok: { palette: PALETTES, mode: READING_MODES, size: TEXT_SIZES, contrast: CONTRASTS, digits: DIGIT_STYLES, images: IMAGE_PREFS },
  }).replace(/</g, "\\u003c");
  return "(function(c){var d=document.documentElement,K=c.keys,A=c.account||{},L={},S=null,v,f,i,"
    + "g=function(k){try{return localStorage.getItem(k)}catch(e){return null}},F=['palette','mode','size','contrast','digits','images'];"
    + "for(i=0;i<F.length;i++){f=F[i];v=g(K[f]);if(c.ok[f].indexOf(v)>=0)L[f]=v}"
    + "if(g(K.palette)===c.legacy){L.palette='classic';if(L.mode===undefined)L.mode='wazeh'}"
    + "if(g(K.contrast)==='')L.contrast='normal';"
    + "v=g(K.nastaliq);if(v==='1')L.nastaliq=true;else if(v==='0'||v==='')L.nastaliq=false;"
    + "try{S=JSON.parse(g(c.snap)||'null')}catch(e){}if(S&&(S.u===undefined||S.u!==c.uid))S=null;"
    + "var fresh=!!c.account&&!(S&&S.at>=c.at),B=(S&&S.p)||{},more=false;"
    + "try{more=matchMedia('(prefers-contrast: more)').matches}catch(e){}"
    + "function p(f){var a=A[f];if(fresh&&a!==undefined&&a!==B[f])return a;if(L[f]!==undefined)return L[f];if(a!==undefined)return a;if(f==='contrast'&&more)return 'high';return c.site[f]}"
    + "d.setAttribute('data-theme',p('palette'));d.setAttribute('data-mode',p('mode'));d.setAttribute('data-size',p('size'));"
    + "d.setAttribute('data-contrast',p('contrast'));d.setAttribute('data-nastaliq',p('nastaliq')?'on':'off');d.setAttribute('data-digits',p('digits'));d.setAttribute('data-images',p('images'));"
    + "try{if(navigator.connection&&navigator.connection.saveData)d.setAttribute('data-save-data','on')}catch(e){}"
    + `})(${cfg});`;
}

/** hreflang alternates for a locale-independent path ("" for the front page), matching the Link header next-intl sends. */
export function alternatesFor(path: string, locale: Locale) {
  return { canonical: `/${locale}${path}`, languages: { en: `/en${path}`, ur: `/ur${path}`, "x-default": path || "/" } };
}
