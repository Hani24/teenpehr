import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword, type PasswordProblem } from "./password";
import { retireLinksMadeBy } from "./invites";
import { loginSucceeded, reserveLoginAttempt } from "./rate-limit";
import { destroyAllSessions, invalidateUserCache } from "./session";
import type { Role } from "./roles";

const { users } = schema;

/** Email as stored: trimmed, NFC, lowercase. */
export function normalizeEmail(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}
/** zod for an email field: normalised, then checked. */
export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export class AuthError extends Error {
  constructor(public code: "last_owner" | "no_user") { super(code); }
}

export type AuthResult =
  | { ok: true; user: { id: number; email: string; name: string; role: Role } }
  | { ok: false; reason: "rate_limited" | "invalid" | "disabled" };

/**
 * Check an email and password against the rate limit and the users table. The attempt is recorded
 * (as a failure) together with the limit check, before the password is hashed, and marked a success
 * afterwards, so parallel guesses cannot all pass the check at once (lib/auth/rate-limit.ts).
 * It does not sign in: on success call createSession(user.id, await requestMeta()). "disabled" is
 * only ever returned with the right password, so it reveals nothing to someone guessing.
 */
export async function authenticate(input: { email: string; password: string; ip?: string }): Promise<AuthResult> {
  const email = normalizeEmail(input.email), ip = input.ip ?? "";
  const attempt = await reserveLoginAttempt(email, ip);
  if (attempt === null) return { ok: false, reason: "rate_limited" };
  const [u] = email.length <= 320 && input.password.length <= 1000
    ? await db.select().from(users).where(eq(users.email, sql`lower(${email})`)) : [];
  const ok = u?.passwordHash ? await verifyPassword(input.password, u.passwordHash) : await burnPasswordCheck(input.password);
  const active = ok && u.status === "active";
  if (!active) return { ok: false, reason: ok ? "disabled" : "invalid" };
  await loginSucceeded(attempt);
  return { ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role } };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Throws AuthError("last_owner") when `userId` is the only active owner, so the site can never lose its
 * last one. Inside the transaction that makes the change, after a lock every owner change takes, so two
 * owners demoting or disabling each other at the same moment cannot both pass the check.
 */
async function keepAnOwner(tx: Tx, userId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tabayyun:owners'))`);
  const [target] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, userId));
  if (!target) throw new AuthError("no_user");
  if (target.role !== "owner" || target.status !== "active") return;
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users)
    .where(and(eq(users.role, "owner"), eq(users.status, "active"), ne(users.id, userId)));
  if (n === 0) throw new AuthError("last_owner");
}

/**
 * Anything but owner also retires the open invite and reset links this user made: they could create
 * owners, and their maker no longer may (consumeInvite refuses them too, as a second check).
 */
export async function setUserRole(userId: number, role: Role): Promise<void> {
  await db.transaction(async (tx) => {
    if (role !== "owner") {
      await keepAnOwner(tx, userId);
      await retireLinksMadeBy(tx, userId);
    }
    await tx.update(users).set({ role }).where(eq(users.id, userId));
  });
  invalidateUserCache(userId);
}

/**
 * Disabling signs the user out everywhere, which also turns off their feed link and their own open
 * reset link (destroyAllSessions), and retires the links they made, so switching the account back on
 * brings none of them back. Their saved shelf and history stay.
 */
export async function setUserStatus(userId: number, status: "active" | "disabled"): Promise<void> {
  await db.transaction(async (tx) => {
    if (status === "disabled") {
      await keepAnOwner(tx, userId);
      await retireLinksMadeBy(tx, userId);
    }
    await tx.update(users).set({ status }).where(eq(users.id, userId));
  });
  if (status === "disabled") await destroyAllSessions(userId);
  invalidateUserCache(userId);
}

/**
 * Set a signed-in user's own new password (the reset link goes through consumeInvite instead). Other
 * sessions are signed out, and the feed link and any open reset link stop working (destroyAllSessions);
 * this browser's session stays. Returns the policy problem, or null when it was set.
 */
export async function setPassword(userId: number, password: string): Promise<PasswordProblem | null> {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!u) throw new AuthError("no_user");
  const problem = passwordProblem(password, u.email);
  if (problem) return problem;
  await db.update(users).set({ passwordHash: await hashPassword(password), passwordChangedAt: new Date() }).where(eq(users.id, userId));
  await destroyAllSessions(userId, { exceptCurrent: true });
  return null;
}
