/*
 * Tabayyun service worker: offline reading (decision D3 in docs/PLAN.md). Plain JavaScript, served
 * as-is from /sw.js and registered by components/sw-register.tsx in production builds only.
 *
 * - /_next/static/* and /fonts/*: cache-first (both are content-hashed or versioned).
 * - /media/* (story images, D6; content-addressed, never changed): cache-first in their own cache,
 *   MEDIA_MAX entries at most, the oldest dropped first. Only a 200 WebP answer is kept (signed out,
 *   /media answers 401, which is never kept); a miss asks the server, not the browser's HTTP cache
 *   (fetchMedia), so nothing comes back after sign-out. The sync also keeps the manifest's `media` list
 *   (the 480 px pictures of the kept stories), except on a data-saving connection.
 * - Reader pages under /en and /ur (READER_PAGE): network-first, falling back to the copy kept on
 *   this device, which is served with data-tb-cached="<when it was kept>" on <html> so the page can
 *   say it is a saved copy (components/offline-banner.tsx). A slow network (NETWORK_TIMEOUT_MS) or a
 *   server error (5xx) gets the kept copy too, and a good network answer still refreshes it. Pages
 *   are keyed by path, plus ?page=N for the later pages of a list (keyOf).
 * - Never cached: /admin, /api/*, sign-in and account pages (anything not in READER_PAGE), file
 *   downloads, other origins, and any response that is not a plain 200 (redirects included).
 * - A navigation that fails with nothing kept gets /{locale}/offline, or a built-in page.
 * - Sync: the page posts {type: "tb:sync", manifest} (from /api/offline/manifest: the latest
 *   editions and their stories, and the reader's Saved shelf); pages are fetched one at a time.
 * - Sign-out clears every cache (images included): the message {type: "tb:clear"}, a sign-in page that answers 200
 *   (it renders only for someone signed out; the logout route lands on ?ok=signed_out there), a page
 *   containing data-tb-offline="clear", or a sync that the server sends to sign in. A manifest for a
 *   different account than the kept pages' (an invite or reset link signs one in on this browser
 *   without the sign-in page) clears them before it is kept.
 *
 * Bump VERSION when the caching rules change; activate deletes every other tb-* cache.
 */
const VERSION = "v2";
const CACHE_PREFIX = "tb-";
const STATIC_CACHE = `${CACHE_PREFIX}static-${VERSION}`;
const PAGES_CACHE = `${CACHE_PREFIX}pages-${VERSION}`;
/** Images have their own version: bump it when their caching rules change (pages and scripts stay). */
const MEDIA_VERSION = "v1";
const MEDIA_CACHE = `${CACHE_PREFIX}media-${MEDIA_VERSION}`;
const CACHED_AT = "x-tb-cached-at";
const STATE_KEY = "/__tb/state.json";
const CLEAR_MARKER = 'data-tb-offline="clear"';
const SIGNED_OUT_PARAM = "signedout";
const LOCALES = ["en", "ur"];
const NETWORK_TIMEOUT_MS = 7000;
/** A kept page older than this is fetched again by the next sync (corrections are appended to stories). */
const PAGE_REFRESH_MS = 24 * 3600 * 1000;
/** Pages kept from browsing but no longer in the manifest go after this long. */
const VISITED_KEEP_MS = 7 * 24 * 3600 * 1000;
const PAGES_MAX = 450;
const STATIC_MAX = 400;
const ASSETS_PER_SYNC = 120;
/** Most story images kept on the device (about 50 KB each at 480 px). */
const MEDIA_MAX = 200;

// Reader pages: front page, editions (and their print view), stories, sections, topics and names,
// archive, about, the Saved shelf, and the offline page. Anything else under /en or /ur (sign-in,
// invites, account, search) is never cached.
const READER_PAGE = /^\/(en|ur)(?:\/?|\/\d{4}-\d{2}-\d{2}\/(?:subh|dopahar|shaam)(?:\/print)?\/?|\/story\/\d+\/?|\/(?:section|entity)\/[a-z0-9-]+\/?|\/topic(?:\/[a-z0-9-]+)?\/?|\/(?:archive|about|saved|offline)\/?)$/;
const SIGN_IN_PAGE = /^\/(en|ur)\/(?:login|logout|signout|sign-out)\/?$/;
const NEVER = /^\/(?:admin|api)(?:\/|$)/;
const DOWNLOAD = /\/download\/?$/;
const STATIC = /^\/(?:_next\/static|fonts)\//;
// A stored image variant: /media/<sha256>-<width>.webp (web/lib/media.ts MEDIA_FILE_RE), nothing else.
const MEDIA = /^\/media\/[0-9a-f]{64}-[1-9][0-9]{1,3}\.webp$/;
// Static files named in a page or a stylesheet (scripts, styles, fonts), to keep alongside it.
const ASSET_REF = /\/(?:_next\/static\/[^"'\s()<>\\]+?\.(?:js|css|woff2)|fonts\/[^"'\s()<>\\]+?\.woff2(?:\?v=[\w.-]+)?)/g;

/** Bumped by every purge, so a sync or a network answer in flight never writes into a cleared cache. */
let generation = 0;
let syncing = null;
let queued = null;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // Keep the offline pages now if they can be had (a signed-out install gets the built-in page).
  event.waitUntil(Promise.all(LOCALES.map((l) => fetchAndKeep(`/${l}/offline`, `/${l}/offline`).catch(() => null))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== STATIC_CACHE && k !== PAGES_CACHE && k !== MEDIA_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.test(url.pathname) || DOWNLOAD.test(url.pathname)) return;
  if (STATIC.test(url.pathname)) {
    event.respondWith(cacheFirst(event, req));
    return;
  }
  if (MEDIA.test(url.pathname)) {
    event.respondWith(mediaFirst(event, req, url));
    return;
  }
  // Only document loads. Next's RSC requests (client-side navigations, prefetches) go straight to the
  // network; when that fails offline, Next falls back to a document load, which lands here.
  if (req.mode !== "navigate") return;
  if (signedOutUrl(url)) event.waitUntil(purge());
  if (READER_PAGE.test(url.pathname)) {
    const key = keyOf(url);
    const gen = generation;
    const network = fetch(req);
    // The copy is cloned the moment the answer arrives (this reaction runs before networkFirst's) and
    // read in the background, so the page still streams in instead of waiting for its whole body.
    event.waitUntil(network.then((res) => (keepable(res) ? keepCopy(res.clone(), key, gen) : undefined)).catch(() => undefined));
    event.respondWith(networkFirst(network, key, url));
    return;
  }
  event.respondWith(networkOnly(event, req, url));
});

self.addEventListener("message", (event) => {
  const data = event.data && typeof event.data === "object" ? event.data : {};
  if (data.type === "tb:clear") {
    event.waitUntil(purge().then(() => reply(event, { type: "tb:cleared" })));
  } else if (data.type === "tb:sync") {
    event.waitUntil(startSync(data.manifest, { saveData: data.saveData === true }).then((r) => reply(event, { type: "tb:synced", ...r })));
  } else if (data.type === "tb:list") {
    event.waitUntil(listKept(data.locale).then((r) => reply(event, { type: "tb:list", ...r })));
  }
});

/**
 * The sign-in page after the logout route (?ok=signed_out / signed_out_all, or ?signedout): cleared
 * before the page loads. Only on a sign-in page, so a crafted link elsewhere cannot wipe the copies.
 */
function signedOutUrl(url) {
  return SIGN_IN_PAGE.test(url.pathname) && (url.searchParams.has(SIGNED_OUT_PARAM) || /^signed_out/.test(url.searchParams.get("ok") || ""));
}

function reply(event, msg) {
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(msg);
}

/* ---- strategies ------------------------------------------------------------------------------ */

async function cacheFirst(event, req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200 && res.type === "basic") {
    const gen = generation;
    event.waitUntil(res.clone().arrayBuffer().then((body) => gen === generation ? cache.put(req, new Response(body, { headers: res.headers })) : undefined).catch(() => undefined));
  }
  return res;
}

/**
 * A story image: the kept copy, else the network (kept when it is a 200 WebP). Offline and not kept: an
 * error, and the page shows the frame's colour.
 */
async function mediaFirst(event, req, url) {
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(url.pathname);
  if (hit) return hit;
  const res = await fetchMedia(url.pathname);
  if (keepableMedia(res)) {
    const gen = generation;
    event.waitUntil(res.clone().arrayBuffer().then((body) => putMedia(cache, url.pathname, body, gen)).catch(() => undefined));
  }
  return res;
}

/**
 * An image from the server, never straight from the browser's HTTP cache: /media answers with a year-long
 * private Cache-Control, and without this a copy there would outlive sign-out (and be kept here again).
 * "no-cache" makes the browser ask the server first, which answers 304 to a signed-in reader and 401 once
 * signed out. By path, not the page's Request: a navigation's Request cannot take options.
 */
function fetchMedia(path) {
  return fetch(path, { credentials: "same-origin", cache: "no-cache" });
}

function keepableMedia(res) {
  return res.status === 200 && res.type === "basic" && !res.redirected && (res.headers.get("content-type") || "").split(";")[0].trim() === "image/webp";
}

/** Keep an image (unless a purge came since `gen`), then drop the oldest past MEDIA_MAX. */
async function putMedia(cache, path, body, gen) {
  if (gen !== generation) return;
  await cache.put(path, new Response(body, { status: 200, headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=31536000, immutable" } }));
  await trim(cache, MEDIA_MAX);
}

async function networkFirst(network, key, url) {
  const cache = await caches.open(PAGES_CACHE);
  const kept = await cache.match(key);
  if (kept && self.navigator.onLine === false) return asKept(kept);
  try {
    const res = await (kept ? withTimeout(network, NETWORK_TIMEOUT_MS) : network);
    // The server is up but failing (a deploy, the database down): the kept copy reads better than an error.
    if (kept && res.status >= 500) return asKept(kept);
    return res;
  } catch {
    if (kept) return asKept(kept);
    return offlineFallback(url);
  }
}

async function networkOnly(event, req, url) {
  try {
    const res = await fetch(req);
    // A sign-in page that answers 200 means nobody is signed in here any more.
    if (SIGN_IN_PAGE.test(url.pathname) && res.status === 200) event.waitUntil(purge());
    return res;
  } catch {
    return offlineFallback(url);
  }
}

/**
 * Fetch a page and keep it when it is a plain 200 HTML answer from this origin. Returns the network
 * response untouched either way. A page carrying the sign-out marker clears everything instead.
 */
async function fetchAndKeep(reqOrUrl, key) {
  const gen = generation;
  const res = await fetch(reqOrUrl, typeof reqOrUrl === "string" ? { credentials: "same-origin", cache: "no-store" } : undefined);
  if (keepable(res)) await keepCopy(res.clone(), key, gen);
  return res;
}

/** Keep a page answer (a clone, read here) unless a purge came since `gen`; the sign-out marker purges instead. */
async function keepCopy(res, key, gen) {
  const text = await res.text();
  if (text.includes(CLEAR_MARKER)) return purge();
  if (gen === generation) await (await caches.open(PAGES_CACHE)).put(key, stamped(text, res));
}

function keepable(res) {
  return res.status === 200 && res.type === "basic" && !res.redirected && (res.headers.get("content-type") || "").includes("text/html");
}

/** The HTML as kept: the body as text, plus the time it was kept. */
function stamped(text, res) {
  return new Response(text, { status: 200, headers: { "Content-Type": res.headers.get("content-type") || "text/html; charset=utf-8", [CACHED_AT]: new Date().toISOString() } });
}

/** A kept page as served: marked on <html> so the page can tell the reader it is a saved copy. */
async function asKept(res) {
  const at = (res.headers.get(CACHED_AT) || "").replace(/[^0-9TZ:.+-]/g, "");
  const text = await res.text();
  return new Response(text.replace(/<html\b/i, `<html data-tb-cached="${at}"`), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** A page's key in the cache: its path, plus ?page=N past the first page of a list (topics, names). */
function keyOf(url) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const page = url.searchParams.get("page");
  return page && /^\d{1,3}$/.test(page) && Number(page) > 1 ? `${p}?page=${Number(page)}` : p;
}

function localeOf(url) {
  const m = /^\/(en|ur)(?:\/|$)/.exec(url.pathname);
  return m ? m[1] : null;
}

async function offlineFallback(url) {
  const cache = await caches.open(PAGES_CACHE);
  const locale = localeOf(url) || (await lastLocale(cache));
  // The bare site address: the front page last kept in the reader's language.
  if (url.pathname === "/") {
    const home = await cache.match(`/${locale}`);
    if (home) return asKept(home);
  }
  const page = await cache.match(`/${locale}/offline`);
  if (page) return new Response(await page.text(), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  return new Response(builtInOfflinePage(locale), { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function lastLocale(cache) {
  const s = await readState(cache);
  return LOCALES.includes(s.locale) ? s.locale : "en";
}

/** What the last sync recorded: {locale, owner}, or {} when nothing is kept. */
async function readState(cache) {
  try {
    const res = await (cache || (await caches.open(PAGES_CACHE))).match(STATE_KEY);
    const s = res ? await res.json() : null;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function sameOriginSignIn(href) {
  try {
    const u = new URL(href);
    return u.origin === self.location.origin && SIGN_IN_PAGE.test(u.pathname);
  } catch {
    return false;
  }
}

function builtInOfflinePage(locale) {
  const ur = locale === "ur";
  const title = ur ? "آپ آف لائن ہیں" : "You are offline";
  const text = ur
    ? "یہ صفحہ اس آلے پر محفوظ نہیں۔ انٹرنیٹ ملنے پر دوبارہ کوشش کریں۔"
    : "This page is not kept on this device. Try again when you are connected.";
  const retry = ur ? "دوبارہ کوشش کریں" : "Try again";
  return `<!doctype html><html lang="${ur ? "ur" : "en"}" dir="${ur ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>`
    + `<style>:root{color-scheme:light dark}body{margin:0;padding:3rem 1rem;font:1.15rem/1.6 system-ui,sans-serif;background:#f7f3ec;color:#1c1917}@media (prefers-color-scheme:dark){body{background:#0f1115;color:#ece7de}a{color:#ece7de}}main{max-width:34rem;margin:0 auto}`
    + `:lang(ur){font-family:"Noto Nastaliq Urdu","Noto Naskh Arabic",serif;line-height:2.2;letter-spacing:0}h1{font-size:1.8rem;line-height:1.3}a{color:#1c1917;display:inline-block;padding:.6rem 1rem;border:2px solid currentColor;border-radius:999px;text-decoration:none;min-height:48px;box-sizing:border-box}</style></head>`
    + `<body><main><h1>${title}</h1><p>${text}</p><p><a href="">${retry}</a></p></main></body></html>`;
}

/* ---- sync -------------------------------------------------------------------------------------- */

/** One sync at a time; a manifest that arrives meanwhile runs next (only the newest is kept). */
function startSync(manifest, opts) {
  if (syncing) {
    queued = { manifest, opts };
    return syncing;
  }
  syncing = (async () => {
    let r = await sync(manifest, opts).catch(() => ({ failed: -1 }));
    while (queued) {
      const q = queued;
      queued = null;
      r = await sync(q.manifest, q.opts).catch(() => ({ failed: -1 }));
    }
    return r;
  })().finally(() => { syncing = null; });
  return syncing;
}

function validPage(p) {
  return p && typeof p.url === "string" && p.url.startsWith("/") && !p.url.startsWith("//") && READER_PAGE.test(p.url) && typeof p.title === "string";
}

async function sync(m, opts) {
  if (!m || m.v !== 1 || !LOCALES.includes(m.locale) || !Array.isArray(m.pages) || typeof m.owner !== "string" || !m.owner) return { failed: -1 };
  // Kept for another account: none of it may outlive the switch.
  const state = await readState();
  if (state.owner && state.owner !== m.owner) await purge();
  const gen = generation;
  const pagesCache = await caches.open(PAGES_CACHE);
  const staticCache = await caches.open(STATIC_CACHE);
  // On a data-saving connection, keep the editions and the shelf, not every story of every edition.
  const pages = m.pages.filter(validPage).filter((p) => !opts.saveData || p.kind !== "story" || p.shelf);
  const assets = new Set();
  let fetched = 0, kept = 0, failed = 0;
  // One page at a time: polite to the server and to a slow connection.
  for (const p of pages) {
    if (gen !== generation) return { aborted: true };
    const hit = await pagesCache.match(p.url);
    const age = hit ? Date.now() - (Date.parse(hit.headers.get(CACHED_AT) || "") || 0) : Infinity;
    if (hit && !p.fresh && age < PAGE_REFRESH_MS) {
      kept++;
      continue;
    }
    try {
      const res = await fetch(p.url, { credentials: "same-origin", cache: "no-store" });
      // Sent to sign in by this site: the session ended (signed out elsewhere, expired, disabled), so
      // nothing kept may stay. Any other redirect (a captive portal) or a refusal just stops the sync.
      if (res.redirected && sameOriginSignIn(res.url)) { await purge(); return { signedOut: true }; }
      if (res.redirected || res.status === 401 || res.status === 403) return { fetched, kept, failed, signedOut: true };
      if (!keepable(res)) { failed++; continue; }
      const text = await res.text();
      if (text.includes(CLEAR_MARKER)) { await purge(); return { signedOut: true }; }
      if (gen !== generation) return { aborted: true };
      await pagesCache.put(p.url, stamped(text, res));
      for (const a of text.match(ASSET_REF) || []) assets.add(a);
      fetched++;
    } catch {
      failed++;
      if (self.navigator.onLine === false) break;
    }
  }
  await keepAssets(staticCache, assets, gen);
  if (gen !== generation) return { aborted: true };
  // The kept stories' pictures, after the pages (they matter less), never on a data-saving connection.
  // A refusal (the session ended meanwhile) only stops the pictures; the pages above are kept as usual.
  const media = !opts.saveData && Array.isArray(m.media) ? await keepMedia(m.media, gen) : 0;
  if (gen !== generation) return { aborted: true };
  const index = { locale: m.locale, updatedAt: new Date().toISOString(), pages: pages.map(({ url, kind, title, lang, saved, date, slot }) => ({ url, kind, title, lang: LOCALES.includes(lang) ? lang : undefined, saved: !!saved, date, slot })) };
  await pagesCache.put(`/__tb/offline-index-${m.locale}.json`, new Response(JSON.stringify(index), { headers: { "Content-Type": "application/json" } }));
  await pagesCache.put(STATE_KEY, new Response(JSON.stringify({ locale: m.locale, owner: m.owner }), { headers: { "Content-Type": "application/json" } }));
  await prunePages(pagesCache, new Set(pages.map((p) => p.url)));
  await trim(staticCache, STATIC_MAX);
  return { fetched, kept, failed, media };
}

/** The manifest's images (same-origin /media paths only), one at a time, skipping those already kept. */
async function keepMedia(list, gen) {
  const cache = await caches.open(MEDIA_CACHE);
  const paths = [...new Set(list.filter((p) => typeof p === "string" && MEDIA.test(p)))].slice(0, MEDIA_MAX);
  let fetched = 0;
  for (const p of paths) {
    if (gen !== generation) break;
    if (await cache.match(p)) continue;
    try {
      const res = await fetchMedia(p);
      if (res.redirected || res.status === 401 || res.status === 403) break;
      if (!keepableMedia(res)) continue;
      await putMedia(cache, p, await res.arrayBuffer(), gen);
      fetched++;
    } catch {
      if (self.navigator.onLine === false) break;
    }
  }
  return fetched;
}

/** Scripts, styles and fonts the kept pages use (and fonts their stylesheets use), fetched once. */
async function keepAssets(cache, assets, gen) {
  const queue = [...assets];
  const seen = new Set(queue);
  let n = 0;
  while (queue.length && n < ASSETS_PER_SYNC && gen === generation) {
    const a = queue.shift();
    if (await cache.match(a, { ignoreVary: true })) continue;
    n++;
    try {
      const res = await fetch(a, { credentials: "same-origin" });
      if (res.status !== 200 || res.type !== "basic") continue;
      if (a.endsWith(".css")) {
        const css = await res.clone().text();
        for (const ref of css.match(ASSET_REF) || []) if (!seen.has(ref)) { seen.add(ref); queue.push(ref); }
      }
      if (gen === generation) await cache.put(a, res);
    } catch {
      if (self.navigator.onLine === false) return;
    }
  }
}

/** Drop pages outside the manifest once they are old, and the oldest first when over PAGES_MAX. */
async function prunePages(cache, keep) {
  const reqs = await cache.keys();
  const loose = [];
  for (const r of reqs) {
    const path = new URL(r.url).pathname;
    if (path.startsWith("/__tb/") || keep.has(path)) continue;
    const res = await cache.match(r);
    loose.push({ r, at: Date.parse((res && res.headers.get(CACHED_AT)) || "") || 0 });
  }
  loose.sort((a, b) => a.at - b.at);
  let excess = reqs.length - PAGES_MAX;
  const now = Date.now();
  for (const { r, at } of loose) {
    if (excess > 0 || now - at > VISITED_KEEP_MS) {
      await cache.delete(r);
      excess--;
    }
  }
}

/** Keep at most `max` entries, dropping the oldest added (old builds' hashed files). */
async function trim(cache, max) {
  const reqs = await cache.keys();
  for (let i = 0; i < reqs.length - max; i++) await cache.delete(reqs[i]);
}

/** What the offline page can list: the last manifest's pages that are actually kept. */
async function listKept(locale) {
  const l = LOCALES.includes(locale) ? locale : "en";
  const cache = await caches.open(PAGES_CACHE);
  const res = await cache.match(`/__tb/offline-index-${l}.json`);
  if (!res) return { pages: [], updatedAt: null };
  const index = await res.json().catch(() => null);
  if (!index || !Array.isArray(index.pages)) return { pages: [], updatedAt: null };
  const pages = [];
  for (const p of index.pages) if (validPage(p) && p.kind !== "offline" && (await cache.match(p.url))) pages.push(p);
  return { pages, updatedAt: index.updatedAt || null };
}

/** Sign-out: every cache this worker made, gone; syncs in flight stop writing. */
async function purge() {
  generation++;
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
}
