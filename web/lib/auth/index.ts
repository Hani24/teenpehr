import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { getSessionToken } from "./session";
import { verifySessionToken, type SessionUser } from "./session-store";
import { roleAtLeast, type Role } from "./roles";
import { safeNextPath } from "./paths";

/*
 * Accounts and sign-in (decision D2 in docs/PLAN.md: the whole site is invite-only). Import from
 * "@/lib/auth" on the server. The proxy can import "@/lib/auth/session-store" and "./paths" (no
 * request APIs), and client components "@/lib/auth/roles" and "@/lib/auth/prefs".
 *
 * Security model, in layers:
 * - Accounts: invite only (no sign-up). An owner's invite or reset link is single use, expires, and is
 *   stored as its sha256. Passwords are scrypt; sign-in is rate limited per email and per IP, each
 *   attempt counted before its password is checked (so a parallel burst gets no extra guesses).
 * - Sessions: a random token in the httpOnly, SameSite=Lax tb_session cookie (Secure in production);
 *   the table keeps only its sha256. 30 days, sliding. Password changes, resets, disabling an
 *   account, an owner's sign-out and "sign out everywhere" delete the sessions, and with them the
 *   account's feed token and open reset link (destroyAllSessions). Demoting or disabling an owner
 *   retires the links they made; a link whose maker is no longer an active owner is refused.
 * - The wall: web/proxy.ts checks the session on every request except the open paths in ./paths
 *   (worker API with its bearer token, sign-in/invite/reset pages and /api/auth, feeds with their own
 *   ?token=, icons and manifest). Behind it, the [locale] layout (gate.ts), every admin page and
 *   action (requireAdmin/requireOwner, 403 for readers), the account routes and the feeds check again.
 * - Forms: sign-in, sign-out, invite and reset acceptance, password and feed-link changes are plain
 *   HTML posts to app/api/auth/*, which refuse a cross-site Origin/Referer; admin actions are Server
 *   Actions, which Next checks the same way. ?next= is same-site paths only (safeNextPath).
 * - Caching: responses the proxy lets through are Cache-Control: private, no-store, so no shared cache
 *   can hand one reader's page to another. The site is noindex (robots.txt, meta, X-Robots-Tag).
 * - Feeds: /{locale}/feed.xml|json need ?token= (a per-account secret, stored as sha256; rotating it
 *   retires the old one; signing out everywhere, a password change or reset and disabling clear it).
 */
export * from "./session";
export { roleAtLeast, isRole, ROLES, type Role } from "./roles";
export { hashPassword, verifyPassword, passwordProblem, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, type PasswordProblem } from "./password";
export { loginAllowed, reserveLoginAttempt, loginSucceeded, recordLoginAttempt } from "./rate-limit";
export { createInvite, checkInvite, consumeInvite, revokeInvite, retireLinksMadeBy, retireResetLinks, inviteUrl, InviteError, type InviteKind, type InviteCheck, type ConsumeResult } from "./invites";
export { rotateFeedToken, revokeFeedToken, userForFeedToken } from "./feed-token";
export { authenticate, setUserRole, setUserStatus, setPassword, normalizeEmail, emailSchema, AuthError, type AuthResult } from "./users";
export { parsePrefs, storedPrefs, DEFAULT_PREFS, type Prefs, type PrefsPatch } from "./prefs";

/** The signed-in user of this request, or null. Deduplicated per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await verifySessionToken(await getSessionToken());
  return session?.user ?? null;
});

/**
 * Only a same-site path ("/en/…"), never "//host", a full URL, or one with whitespace or control
 * characters, so ?next= cannot redirect off-site (see safeNextPath in ./paths).
 */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  return safeNextPath(next, fallback);
}

/** Where to sign in: /{locale}/login, with ?next= to come back to. */
export function loginPath(locale: "en" | "ur" = "en", next?: string | null): string {
  const back = next ? safeNext(next, "") : "";
  return `/${locale}/login${back ? `?next=${encodeURIComponent(back)}` : ""}`;
}

/** The signed-in user; anyone else is redirected to the sign-in page (then back to `next`). */
export async function requireUser(opts: { locale?: "en" | "ur"; next?: string } = {}): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(loginPath(opts.locale ?? "en", opts.next));
  return user;
}

/**
 * The signed-in user with at least `minRole`. Not signed in: redirected to sign in. Signed in without
 * the role: a 404, so readers never learn which admin pages exist.
 */
export async function requireRole(minRole: Role, opts: { locale?: "en" | "ur"; next?: string } = {}): Promise<SessionUser> {
  const user = await requireUser(opts);
  if (!roleAtLeast(user.role, minRole)) notFound();
  return user;
}
