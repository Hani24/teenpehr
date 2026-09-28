import "server-only";
import { cookies, headers } from "next/headers";
import { and, eq, lt, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { hashToken, looksLikeToken, newToken } from "./tokens";
import { retireResetLinks } from "./invites";
import { forgetSession, invalidateUserCache, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionCookieOptions } from "./session-store";

/*
 * The cookie side of sessions: sign in, sign out, sign out everywhere. Lookups, the cache and the
 * cookie settings are in session-store.ts, which reads no request state, so web/proxy.ts can use it.
 * createSession, destroySession and destroyAllSessions set cookies: call them only from a Server
 * Action or a Route Handler.
 */
export * from "./session-store";

const { sessions, users } = schema;

/**
 * User agent and client IP of this request, for createSession and the rate limit. The IP is the last
 * X-Forwarded-For hop: the address the nearest proxy saw, which a client cannot choose (whatever it
 * sent stays to the left of it). Next's server fills the header from the socket only when it is
 * absent, so the app must be reachable only through that one proxy (the unit binds 127.0.0.1), or
 * directly with no proxy at all. Else X-Real-IP, else "".
 */
export async function requestMeta(): Promise<{ ua: string; ip: string }> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1) ?? "";
  return { ua: (h.get("user-agent") ?? "").slice(0, 400), ip: (fwd || h.get("x-real-ip") || "").slice(0, 64) };
}

/** The raw session token from the request cookie, if any. */
export async function getSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Sign a user in: store a new session and set the tb_session cookie. Only from a Server Action or Route
 * Handler (cookies cannot be set while rendering). Returns the raw token.
 */
export async function createSession(userId: number, meta: { ua?: string | null; ip?: string | null } = {}): Promise<string> {
  const raw = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await db.insert(sessions).values({ id: hashToken(raw), userId, expiresAt, lastSeenAt: now, userAgent: (meta.ua ?? "").slice(0, 400), ip: (meta.ip ?? "").slice(0, 64) });
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, now))); // tidy this user's dead sessions
  (await cookies()).set(SESSION_COOKIE, raw, sessionCookieOptions());
  return raw;
}

/** Sign out this browser: delete its session and clear the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (looksLikeToken(raw)) {
    const id = hashToken(raw);
    forgetSession(id);
    await db.delete(sessions).where(eq(sessions.id, id));
  }
  jar.set(SESSION_COOKIE, "", sessionCookieOptions(0));
}

/**
 * Sign a user out everywhere ("sign out everywhere", a password change, an owner's sign-out, or when an
 * owner disables them). Every other standing way into the account goes with the sessions: the private
 * feed token (users.feed_token_hash) and any open reset link for it. Someone who briefly had the
 * account could have made either, and each outlives a session; so after this the account has no way
 * in but its password, and switching a disabled account back on revives neither. With
 * `exceptCurrent`, the session of this request's cookie survives. Returns how many sessions were deleted.
 */
export async function destroyAllSessions(userId: number, opts: { exceptCurrent?: boolean } = {}): Promise<number> {
  const raw = opts.exceptCurrent ? await getSessionToken() : null;
  const keep = looksLikeToken(raw) ? hashToken(raw) : null;
  const gone = await db.transaction(async (tx) => {
    const rows = await tx.delete(sessions)
      .where(keep ? and(eq(sessions.userId, userId), ne(sessions.id, keep)) : eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    await tx.update(users).set({ feedTokenHash: null }).where(eq(users.id, userId));
    await retireResetLinks(tx, userId);
    return rows;
  });
  invalidateUserCache(userId);
  return gone.length;
}
