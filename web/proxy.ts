import { NextRequest, NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { SESSION_COOKIE, sessionCookieOptions, verifySessionToken } from "@/lib/auth/session-store";
import { isFeed, isMedia, isOpenPath, isPublicFile, isWorkerApi, PATH_HEADER, safeNextPath, wallLocale } from "@/lib/auth/paths";
import { roleAtLeast, type Role } from "@/lib/auth/roles";
import { forbiddenHtml } from "@/lib/auth/forbidden-page";

/*
 * The login wall (decision D2) and locale routing. Runs on the Node runtime for every request except
 * built assets and fonts. The worker API passes untouched (bearer token in its routes); the open paths
 * in lib/auth/paths.ts pass without a session; everything else needs a valid tb_session cookie.
 * Signed out, a page request is sent to /{locale}/login?next=…, anything else (the API, /media images)
 * gets a 401 (a Server Action's 401 carries x-action-redirect, so Next's client goes to sign in rather
 * than fail). Signed in without the role for an admin address (readers; editors on /admin/users and
 * /admin/export), a plain 403 page.
 *
 * Not the only check: the [locale] layout, every admin page and action, the account routes and the
 * feeds verify the session (or token) themselves, so a gap here fails closed.
 */
const intl = createMiddleware(routing);

// Paths next-intl should prefix with a locale: not the API, admin, Next internals or files.
const NOT_LOCALIZED = /^\/(?:api|admin|media|_next|_vercel|fonts|snapshots|icon|apple-icon|opengraph-image|twitter-image)/;

/** Never cached by a browser or anything between: pages are per reader, and so are the sign-in pages' cookies. */
const PRIVATE = "private, no-store";

export default async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isWorkerApi(pathname)) return NextResponse.next();

  // The path the pages' own check reads (lib/auth/gate.ts); whatever the client sent is replaced.
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, pathname);

  const open = isOpenPath(pathname);
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  const session = open ? null : await verifySessionToken(raw);

  if (!open && !session) {
    const res = signedOut(req, pathname, search);
    res.headers.set("Cache-Control", PRIVATE);
    return res;
  }

  // The admin is for editors (and its accounts page for owners): anyone else gets a plain 403 page.
  const need = adminRole(pathname);
  if (session && need && !roleAtLeast(session.user.role, need)) {
    return new NextResponse(forbiddenHtml(), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": PRIVATE } });
  }

  const localized = !NOT_LOCALIZED.test(pathname) && !pathname.includes(".");
  // next-intl copies the request headers it is given onto the request the page sees.
  const res = localized ? intl(new NextRequest(req.url, { headers })) : NextResponse.next({ request: { headers } });
  // Static files keep Next's caching; the feeds and the images (/media) set their own (private) caching.
  if (!isPublicFile(pathname) && !isFeed(pathname) && !isMedia(pathname)) res.headers.set("Cache-Control", PRIVATE);
  // Sliding expiry: the lookup extended the session, so the cookie's max-age follows.
  if (session?.touched && raw) res.cookies.set(SESSION_COOKIE, raw, sessionCookieOptions());
  return res;
}

/** Owner-only admin areas: accounts, and the research exports (every table, D5). */
const OWNER_ONLY = ["/admin/users", "/admin/export"];

function adminRole(pathname: string): Role | null {
  if (OWNER_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return "owner";
  if ((pathname === "/admin" || pathname.startsWith("/admin/")) && pathname !== "/admin/login") return "editor";
  return null;
}

function signedOut(req: NextRequest, pathname: string, search: string): NextResponse {
  const isPage = (req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/api/") && !isMedia(pathname);
  // A Server Action posted from a page whose session has since ended (expired, signed out in another
  // tab, account switched off). The action does not run; Next's client follows x-action-redirect to
  // the sign-in page (then back to that page) instead of failing on an "unexpected response".
  if (req.method === "POST" && req.headers.has("next-action") && !pathname.startsWith("/api/")) {
    const to = loginUrl(req, pathname, search);
    return new NextResponse(null, { status: 401, headers: { "x-action-redirect": `${to.pathname}${to.search};push` } });
  }
  if (!isPage) {
    return pathname.startsWith("/api/")
      ? NextResponse.json({ error: "sign in required" }, { status: 401 })
      : new NextResponse("Sign in required.\n", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return NextResponse.redirect(loginUrl(req, pathname, search));
}

/** /{locale}/login, with ?next= back to this page when it is a same-site path worth returning to. */
function loginUrl(req: NextRequest, pathname: string, search: string): URL {
  const locale = wallLocale(pathname, req.cookies.get("NEXT_LOCALE")?.value, req.headers.get("accept-language"));
  const url = new URL(`/${locale}/login`, req.url);
  const params = new URLSearchParams(search);
  params.delete("_rsc"); // the router's cache-busting parameter, not part of the page address
  // A file download (an edition, the Saved shelf, an export) comes back to its page after signing in: the file
  // itself would leave the reader looking at the sign-in form while the browser saves it.
  const page = pathname.replace(/\/download\/?$/, "").replace(/^(\/admin\/export)\/[^/]+\/?$/, "$1") || "/";
  const back = page + (params.size && page === pathname ? `?${params}` : "");
  const next = safeNextPath(back, "");
  if (next && next !== "/" && next !== `/${locale}`) url.searchParams.set("next", next);
  return url;
}

export const config = {
  // Everything but Next's own assets and endpoints, the dev overlay's, and the fonts.
  matcher: ["/((?!_next/|__nextjs|fonts/).*)"],
};
