import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { hashToken, looksLikeToken, newToken } from "./tokens";
import type { Role } from "./roles";

/*
 * Private feed URLs. Feed readers cannot sign in, so each account may have one secret token for its
 * RSS/JSON feeds (…/feed.xml?token=…). Only its sha256 is stored; rotating replaces the old one. It is
 * a way into the account that outlives a session, so everything that ends every session ends it too:
 * sign out everywhere, a password change, a reset link, an owner's sign-out and disabling the account
 * (destroyAllSessions in ./session.ts, consumeInvite in ./invites.ts). A re-enabled account has none.
 */
const { users } = schema;

/** A new feed token for the user (the old one stops working). Returns the raw token, shown once. */
export async function rotateFeedToken(userId: number): Promise<string> {
  const raw = newToken();
  await db.update(users).set({ feedTokenHash: hashToken(raw) }).where(eq(users.id, userId));
  return raw;
}

export async function revokeFeedToken(userId: number): Promise<void> {
  await db.update(users).set({ feedTokenHash: null }).where(eq(users.id, userId));
}

/** The active account a feed token belongs to, or null. */
export async function userForFeedToken(raw: string | null | undefined): Promise<{ id: number; email: string; name: string; role: Role; prefs: Record<string, unknown> } | null> {
  if (!looksLikeToken(raw)) return null;
  const [u] = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, prefs: users.prefs }).from(users)
    .where(and(eq(users.feedTokenHash, hashToken(raw)), eq(users.status, "active")));
  return u ?? null;
}
