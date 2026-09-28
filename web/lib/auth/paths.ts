/*
 * Where the login wall (web/proxy.ts) stands, decision D2. Pure functions with no server imports, so
 * the proxy, the route handlers under app/api/auth and the pages share one list.
 *
 * Outside the wall: the worker API (its own bearer token), the sign-in, invite and reset pages and
 * their form handlers, the feeds (the route checks ?token= itself), and the files a browser fetches
 * without cookies or before signing in (icons, manifest, robots.txt, the service worker). Everything
 * else needs a session.
 */
export const WALL_LOCALES = ["en", "ur"] as const;
export type WallLocale = (typeof WALL_LOCALES)[number];

/** Request header the proxy sets to the path it checked (and strips from what the client sent). */
export const PATH_HEADER = "x-tb-path";

const AUTH_PAGE = /^\/(?:en|ur)\/(?:login|invite\/[A-Za-z0-9_-]+|reset\/[A-Za-z0-9_-]+)\/?$/;
const FEED = /^\/(?:en|ur)\/feed\.(?:xml|json)$/;
const FILES = new Set(["/robots.txt", "/manifest.webmanifest", "/sw.js", "/favicon.ico", "/icon.svg"]);
// app/icon.svg and app/apple-icon.tsx; Next may add a hash suffix or an extension.
const ICON = /^\/(?:icon|apple-icon)(?:[-.][A-Za-z0-9.-]*)?$/;

/** The sign-in, invite and reset pages, which render signed out. */
export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGE.test(pathname);
}

export function isWorkerApi(pathname: string): boolean {
  return pathname === "/api/worker" || pathname.startsWith("/api/worker/");
}

/** Files any browser may fetch signed out (icons, manifest, robots.txt, the service worker). */
export function isPublicFile(pathname: string): boolean {
  return FILES.has(pathname) || ICON.test(pathname);
}

export function isFeed(pathname: string): boolean {
  return FEED.test(pathname);
}

/**
 * Publisher images (app/media/[file]/route.ts). Behind the wall, but never a page: signed out they get a
 * 401 rather than the sign-in page, and the route sets its own caching (private, immutable).
 */
export function isMedia(pathname: string): boolean {
  return pathname.startsWith("/media/");
}

/** True when the proxy lets the request through without a session (the route may still check a token). */
export function isOpenPath(pathname: string): boolean {
  return isWorkerApi(pathname) || pathname.startsWith("/api/auth/") || pathname === "/admin/login"
    || isAuthPage(pathname) || isFeed(pathname) || isPublicFile(pathname);
}

/**
 * A same-site path to come back to after signing in, or `fallback`. Only "/…": never "//host",
 * "/\host", a full URL, or anything with whitespace or control characters (browsers drop tabs and
 * newlines from URLs, which would turn "/\t/evil.example" into "//evil.example").
 */
export function safeNextPath(next: unknown, fallback = "/"): string {
  if (typeof next !== "string" || next.length > 2000) return fallback;
  if (!/^\/(?![/\\])/.test(next) || /[\s\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  return next;
}

/** The locale for a sign-in redirect: the path's own, else the next-intl cookie, else the browser's. */
export function wallLocale(pathname: string, cookieLocale?: string | null, acceptLanguage?: string | null): WallLocale {
  const seg = pathname.split("/")[1];
  if (seg === "en" || seg === "ur") return seg;
  if (cookieLocale === "en" || cookieLocale === "ur") return cookieLocale;
  return /(^|,)\s*ur\b/i.test(acceptLanguage ?? "") ? "ur" : "en";
}
