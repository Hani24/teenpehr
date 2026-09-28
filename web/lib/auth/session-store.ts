import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { hashToken, looksLikeToken } from "./tokens";
import type { Role } from "./roles";

/*
 * Database sessions. The cookie holds a random token; the sessions row is keyed by its sha256, so a
 * leaked table cannot be replayed. Expiry slides: a session in use is extended to 30 days from now,
 * written at most every 10 minutes. Lookups are cached in-process for up to 30 s; the cache lives on
 * globalThis so the proxy and the app share it, and destroying a session, disabling a user or
 * changing a role drops the entries (invalidateUserCache).
 */
export const SESSION_COOKIE = "tb_session";
export const SESSION_TTL_SECONDS = 30 * 86_400;
const TOUCH_EVERY_MS = 10 * 60_000;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 5_000;

const { sessions, users } = schema;

export type SessionUser = {
  id: number;
  email: string;
  name: string;
  role: Role;
  /** Raw stored preferences; read them through parsePrefs() in lib/auth/prefs.ts. */
  prefs: Record<string, unknown>;
  /** users.last_visit_at as read: when a request last extended one of the user's sessions (written at most every 10 minutes, not at sign-in). */
  lastVisitAt: Date | null;
};
export type Session = {
  /** sha256 of the cookie token (sessions.id). */
  id: string;
  user: SessionUser;
  expiresAt: Date;
  /** True when this lookup extended the session: the caller that can (proxy, action) re-sets the cookie. */
  touched: boolean;
};

type Entry = { session: Session; cachedAt: number };
const g = globalThis as unknown as { __tbSessionCache?: Map<string, Entry> };
const cache = (g.__tbSessionCache ??= new Map<string, Entry>());

/** Cache a session verifySessionToken just read (callers never see touched=true from the cache). */
export function rememberSession(session: Session) {
  if (cache.size >= CACHE_MAX) {
    const now = Date.now();
    for (const [k, e] of cache) if (now - e.cachedAt > CACHE_TTL_MS) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(session.id, { session: { ...session, touched: false }, cachedAt: Date.now() });
}

/** Drop one cached session (sign-out). */
export function forgetSession(id: string): void {
  cache.delete(id);
}

/** Drop every cached session of a user. Call after changing their role, status, name, prefs or password. */
export function invalidateUserCache(userId: number): void {
  for (const [k, e] of cache) if (e.session.user.id === userId) cache.delete(k);
}

/** Cookie attributes for the session token (also for NextResponse.cookies.set in the proxy). */
export function sessionCookieOptions(maxAgeSeconds = SESSION_TTL_SECONDS) {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: maxAgeSeconds };
}

/**
 * The session behind a raw cookie token, or null (unknown, expired, or the account is disabled or has
 * no password yet). Reads no cookies itself, so web/proxy.ts can call it with request.cookies.
 */
export async function verifySessionToken(rawToken: string | null | undefined): Promise<Session | null> {
  if (!looksLikeToken(rawToken)) return null;
  const id = hashToken(rawToken);
  const now = new Date();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS && hit.session.expiresAt > now) return hit.session;
  if (hit) cache.delete(id);

  const [row] = await db.select({
    id: sessions.id, expiresAt: sessions.expiresAt, lastSeenAt: sessions.lastSeenAt,
    userId: users.id, email: users.email, name: users.name, role: users.role, status: users.status,
    passwordHash: users.passwordHash, prefs: users.prefs, lastVisitAt: users.lastVisitAt,
  }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(eq(sessions.id, id));
  if (!row) return null;
  if (row.expiresAt <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  if (row.status !== "active" || !row.passwordHash) return null;

  const user: SessionUser = { id: row.userId, email: row.email, name: row.name, role: row.role, prefs: row.prefs ?? {}, lastVisitAt: row.lastVisitAt };
  let expiresAt = row.expiresAt, touched = false;
  if (now.getTime() - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
    expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
    touched = true;
    await db.update(sessions).set({ lastSeenAt: now, expiresAt }).where(eq(sessions.id, id));
    await db.update(users).set({ lastVisitAt: now }).where(eq(users.id, row.userId));
  }
  const session: Session = { id, user, expiresAt, touched };
  rememberSession(session);
  return session;
}
