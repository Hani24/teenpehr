"use client";
import { useEffect } from "react";
import { useLocale } from "next-intl";
import { IMAGE_PREFS } from "@/lib/auth/prefs";

/*
 * Offline reading (decision D3): registers public/sw.js (production builds only) and, when online,
 * hands it the list of pages to keep (/api/offline/manifest), at most every SYNC_EVERY_MS unless
 * something was just saved.
 *
 * Sign-out must clear the offline copies. Any of these does it:
 *   - any sign-in page (/{locale}/login renders only for someone signed out; the logout route lands
 *     on /{locale}/login?ok=signed_out), or any page rendered signed out (owner null), or
 *   - render an element with  data-tb-offline="clear"  (this component and the worker look for it), or
 *   - call  clearOfflineCaches()  from client code, or mount  <ClearOfflineCaches />.
 * An account switch without the sign-in page (an invite or reset link signs the new account in on
 * this browser) clears them too: the layout passes the account id as `owner`, and the last one is
 * remembered here (and in the worker, from the manifest). A manifest answered 401 (the session ended
 * elsewhere, expired or was disabled) clears them as well.
 */
export const OFFLINE_CLEAR_SELECTOR = '[data-tb-offline="clear"]';
export const SIGNED_OUT_PARAM = "signedout";
const CACHE_PREFIX = "tb-";
const SYNC_KEY = "tp-offline-sync";
const OWNER_KEY = "tp-offline-owner";
const SYNC_EVERY_MS = 15 * 60_000;
const START_DELAY_MS = 4000;

type SyncState = Record<string, { at: number; version: string }>;
function readState(): SyncState {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY) ?? "{}") as SyncState; } catch { return {}; }
}
function writeState(s: SyncState) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

/** Ask the active worker something and wait (briefly) for its answer. */
function ask<T>(worker: ServiceWorker, msg: unknown, timeoutMs = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = window.setTimeout(() => resolve(null), timeoutMs);
    ch.port1.onmessage = (e) => { window.clearTimeout(t); resolve(e.data as T); };
    worker.postMessage(msg, [ch.port2]);
  });
}

/** The account the kept copies belong to: null when none is recorded, undefined when storage is unavailable. */
function storedOwner(): string | null | undefined {
  try { return localStorage.getItem(OWNER_KEY); } catch { return undefined; }
}

/** Delete every offline copy on this device now (sign-out). Safe anywhere; resolves when done. */
export async function clearOfflineCaches(): Promise<void> {
  try { localStorage.removeItem(SYNC_KEY); localStorage.removeItem(OWNER_KEY); } catch { /* private mode */ }
  const jobs: Promise<unknown>[] = [];
  if (typeof caches !== "undefined") {
    jobs.push(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)))));
  }
  // Also tell the worker, so a sync in flight stops writing.
  const worker = typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null;
  if (worker) jobs.push(ask(worker, { type: "tb:clear" }));
  await Promise.allSettled(jobs);
}

/** Mount on a signed-out page to clear the offline copies once. */
export function ClearOfflineCaches() {
  useEffect(() => { void clearOfflineCaches(); }, []);
  return null;
}

/**
 * This device's images choice as a query parameter (`images=auto|on|off`, from <html data-images>, which the
 * boot script in lib/view.ts sets), so the server follows it even when saving it to the account failed.
 * "" when unknown. `sep` is "?" or "&".
 */
export function imagesParam(sep: "?" | "&"): string {
  const v = typeof document !== "undefined" ? document.documentElement.getAttribute("data-images") : null;
  return v && (IMAGE_PREFS as readonly string[]).includes(v) ? `${sep}images=${v}` : "";
}

/**
 * Fetch the manifest and hand it to the worker. `force` skips the time throttle (after a save).
 * Does nothing offline, signed out (401), or without an active worker.
 */
export async function requestOfflineSync(locale: string, force = false): Promise<void> {
  if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator) || !navigator.onLine) return;
  const state = readState();
  const prev = state[locale];
  if (!force && prev && Date.now() - prev.at < SYNC_EVERY_MS) return;
  try {
    const res = await fetch(`/api/offline/manifest?locale=${encodeURIComponent(locale)}${imagesParam("&")}`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    const json = (res.headers.get("content-type") ?? "").includes("application/json");
    // This site says nobody is signed in any more: what was kept for them goes.
    if (res.status === 401 && json && !res.redirected) { await clearOfflineCaches(); return; }
    if (!res.ok || res.redirected || !json) return;
    const manifest = (await res.json()) as { version?: string };
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) return;
    writeState({ ...state, [locale]: { at: Date.now(), version: String(manifest.version ?? "") } });
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    reg.active.postMessage({ type: "tb:sync", manifest, saveData });
  } catch {
    // offline or the server is down: the next page load tries again
  }
}

let soon = 0;
/** requestOfflineSync(locale, true), once, shortly after the last call (a run of saves syncs once). */
export function syncOfflineSoon(locale: string) {
  window.clearTimeout(soon);
  soon = window.setTimeout(() => { void requestOfflineSync(locale, true); }, 1500);
}

/** Pages the worker keeps for this locale, for the offline page. Empty when there is no worker. */
export type OfflineListedPage = { url: string; kind: string; title: string; lang?: string; saved: boolean };
export async function listOfflinePages(locale: string): Promise<{ pages: OfflineListedPage[]; updatedAt: string | null }> {
  const worker = navigator.serviceWorker?.controller;
  const r = worker ? await ask<{ pages?: unknown; updatedAt?: string | null }>(worker, { type: "tb:list", locale }) : null;
  return { pages: Array.isArray(r?.pages) ? (r.pages as OfflineListedPage[]) : [], updatedAt: r?.updatedAt ?? null };
}

/** This page is one only a signed-out reader sees (a sign-in page, with or without ?signedout / ?ok=signed_out). */
function isSignedOutPage(): boolean {
  return document.querySelector(OFFLINE_CLEAR_SELECTOR) !== null || /^\/(en|ur)\/login\/?$/.test(window.location.pathname);
}

/**
 * Mounted once in the locale layout. Renders nothing. `owner` is the signed-in account's id, null on
 * a page rendered signed out; left out, the account is not checked.
 */
export function SwRegister({ owner }: { owner?: string | null }) {
  const locale = useLocale();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const signedOut = owner === null || isSignedOutPage();
    // Another account's copies (an invite or reset link switched accounts here) go before anything is kept.
    const before = storedOwner();
    const switched = !signedOut && typeof owner === "string" && before !== undefined && before !== owner;
    const cleared = signedOut || switched ? clearOfflineCaches() : Promise.resolve();
    if (switched) void cleared.then(() => { try { localStorage.setItem(OWNER_KEY, owner); } catch { /* private mode */ } });
    if (process.env.NODE_ENV !== "production") {
      // A worker left from a production run on this origin would serve stale pages to `next dev`.
      void navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => {
        if ((r.active ?? r.waiting ?? r.installing)?.scriptURL.endsWith("/sw.js")) void r.unregister();
      }));
      return;
    }
    let timer = 0;
    const sync = () => { if (!signedOut) void cleared.then(() => requestOfflineSync(locale)); };
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      // After the page has settled, so keeping pages never competes with what the reader is loading.
      .then(() => { timer = window.setTimeout(sync, START_DELAY_MS); })
      .catch(() => { /* unsupported or blocked: the site works without it */ });
    window.addEventListener("online", sync);
    return () => { window.clearTimeout(timer); window.removeEventListener("online", sync); };
  }, [locale, owner]);
  return null;
}
