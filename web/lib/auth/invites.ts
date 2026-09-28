import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { hashPassword, passwordProblem, type PasswordProblem } from "./password";
import { recordLoginAttempt } from "./rate-limit";
import { invalidateUserCache } from "./session-store";
import { hashToken, looksLikeToken, newToken } from "./tokens";
import type { Role } from "./roles";

/*
 * Invite and reset links. There is no sign-up: an owner (or `npm run user:invite` for the first owner)
 * creates an invite, and accepting it creates the account. A reset link sets a new password for an
 * existing account. Links are single use; the raw token exists only in the URL (the table keeps its
 * sha256). A new link for the same email and kind retires the older open ones.
 *
 * A link works only while whoever made it is still an active owner (links from `npm run user:invite`
 * have no maker): demoting or switching off an owner retires the open links they made
 * (retireLinksMadeBy), and a link is refused at use if its maker stopped being an active owner some
 * other way. A reset link also stops working when its account signs out everywhere, changes its
 * password or is switched off (retireResetLinks, from destroyAllSessions), so a forgotten one in an
 * old chat cannot be used after the member has recovered another way.
 *
 * Pages that accept them (built by the accounts UI): /{locale}/invite/{token} and /{locale}/reset/{token}.
 */
export const INVITE_TTL_HOURS = 7 * 24;
export const RESET_TTL_HOURS = 24;

const { invites, users, sessions } = schema;
export type InviteKind = "invite" | "reset";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Q = typeof db | Tx;

/** Still open: not used and not expired. */
const open = () => and(isNull(invites.usedAt), gt(invites.expiresAt, sql`now()`));

/** Expire every open link `userId` made (they are no longer an active owner, or are about to stop being one). */
export async function retireLinksMadeBy(q: Q, userId: number): Promise<void> {
  await q.update(invites).set({ expiresAt: sql`now()` }).where(and(eq(invites.createdBy, userId), open()));
}

/** Expire every open reset link for `userId`'s account (it signed out everywhere, changed its password or was switched off). */
export async function retireResetLinks(q: Q, userId: number): Promise<void> {
  await q.update(invites).set({ expiresAt: sql`now()` })
    .where(and(eq(invites.kind, "reset"), open(), sql`${invites.email} = (select ${users.email} from ${users} where ${users.id} = ${userId})`));
}

/**
 * Whether a link's maker may still vouch for it: an active owner, or no maker (the command line). In a
 * transaction, `lock` holds the maker's row until commit, so a demotion running at the same moment
 * either lands first (and the link is refused) or waits until the link is used.
 */
async function makerStillOwner(q: Q, createdBy: number | null, lock = false): Promise<boolean> {
  if (createdBy === null) return true;
  const query = q.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, createdBy));
  const [m] = lock ? await query.for("share") : await query;
  return !!m && m.role === "owner" && m.status === "active";
}

export class InviteError extends Error {
  constructor(public code: "user_exists" | "no_user" | "disabled") { super(code); }
}

function siteUrl(): string {
  return (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}
export function inviteUrl(token: string, kind: InviteKind, locale: "en" | "ur" = "en"): string {
  return `${siteUrl()}/${locale}/${kind}/${token}`;
}

/**
 * Create a link. `invite` needs an email with no account yet (InviteError "user_exists"); `reset` needs
 * an active account (InviteError "no_user" / "disabled") and ignores `role`. Returns the URL to send;
 * it is the only copy of the token.
 */
export async function createInvite(input: {
  email: string; role?: Role; kind?: InviteKind; createdBy?: number | null; locale?: "en" | "ur";
}): Promise<{ id: number; url: string; expiresAt: Date }> {
  const kind = input.kind ?? "invite";
  const email = input.email.normalize("NFC").trim().toLowerCase();
  const [existing] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.email, sql`lower(${email})`));
  if (kind === "invite" && existing) throw new InviteError("user_exists");
  if (kind === "reset" && !existing) throw new InviteError("no_user");
  if (kind === "reset" && existing.status !== "active") throw new InviteError("disabled");
  const role: Role = kind === "reset" ? existing.role : input.role ?? "reader";

  const raw = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (kind === "reset" ? RESET_TTL_HOURS : INVITE_TTL_HOURS) * 3_600_000);
  const id = await db.transaction(async (tx) => {
    await tx.update(invites).set({ expiresAt: now })
      .where(and(eq(invites.email, sql`lower(${email})`), eq(invites.kind, kind), isNull(invites.usedAt), gt(invites.expiresAt, now)));
    const [row] = await tx.insert(invites).values({ tokenHash: hashToken(raw), kind, email: sql`lower(${email})`, role, createdBy: input.createdBy ?? null, expiresAt })
      .returning({ id: invites.id });
    return row.id;
  });
  return { id, url: inviteUrl(raw, kind, input.locale), expiresAt };
}

export type InviteCheck =
  | { ok: true; invite: { id: number; kind: InviteKind; email: string; role: Role; expiresAt: Date } }
  | { ok: false; reason: "invalid" | "used" | "expired" };

/** What a link is for, before its form is submitted (the page shows the email; nothing is changed). */
export async function checkInvite(token: string): Promise<InviteCheck> {
  if (!looksLikeToken(token)) return { ok: false, reason: "invalid" };
  const [inv] = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token)));
  if (!inv) return { ok: false, reason: "invalid" };
  if (inv.usedAt) return { ok: false, reason: "used" };
  if (inv.expiresAt <= new Date()) return { ok: false, reason: "expired" };
  if (!(await makerStillOwner(db, inv.createdBy))) return { ok: false, reason: "expired" };
  return { ok: true, invite: { id: inv.id, kind: inv.kind, email: inv.email, role: inv.role, expiresAt: inv.expiresAt } };
}

export type ConsumeResult =
  | { ok: true; kind: InviteKind; user: { id: number; email: string; name: string; role: Role } }
  | { ok: false; reason: "invalid" | "used" | "expired" | "user_exists" | "disabled" }
  | { ok: false; reason: "weak_password"; problem: PasswordProblem };

/**
 * Accept a link, in one transaction: an invite creates the account (role from the invite), a reset
 * sets the new password, signs every session of the account out and turns its private feed link off.
 * The link is then used, and the email's failed sign-ins are forgiven. A link whose maker is no longer
 * an active owner is refused as expired (and expired, so it leaves the owners' list of open links). It does not sign in; on success call
 * createSession(result.user.id, await requestMeta()).
 */
export async function consumeInvite(token: string, input: { name?: string; password: string }): Promise<ConsumeResult> {
  if (!looksLikeToken(token)) return { ok: false, reason: "invalid" };
  const name = (input.name ?? "").normalize("NFC").trim().slice(0, 100);
  const result = await db.transaction(async (tx): Promise<ConsumeResult> => {
    const [inv] = await tx.select().from(invites).where(eq(invites.tokenHash, hashToken(token))).for("update");
    const now = new Date();
    if (!inv) return { ok: false, reason: "invalid" };
    if (inv.usedAt) return { ok: false, reason: "used" };
    if (inv.expiresAt <= now) return { ok: false, reason: "expired" };
    if (!(await makerStillOwner(tx, inv.createdBy, true))) {
      await tx.update(invites).set({ expiresAt: now }).where(eq(invites.id, inv.id));
      return { ok: false, reason: "expired" };
    }
    const problem = passwordProblem(input.password, inv.email);
    if (problem) return { ok: false, reason: "weak_password", problem };
    const passwordHash = await hashPassword(input.password);

    let user: { id: number; email: string; name: string; role: Role };
    if (inv.kind === "invite") {
      const [u] = await tx.insert(users).values({ email: inv.email, name, role: inv.role, passwordHash, passwordChangedAt: now, invitedBy: inv.createdBy })
        .onConflictDoNothing({ target: users.email }).returning({ id: users.id, email: users.email, name: users.name, role: users.role });
      if (!u) return { ok: false, reason: "user_exists" };
      user = u;
    } else {
      const [u] = await tx.select().from(users).where(eq(users.email, inv.email)).for("update");
      if (!u) return { ok: false, reason: "invalid" };
      if (u.status !== "active") return { ok: false, reason: "disabled" };
      // Whoever had the account loses every way in: its sessions, its feed link and any other open reset link.
      await tx.update(users).set({ passwordHash, passwordChangedAt: now, feedTokenHash: null, ...(name ? { name } : {}) }).where(eq(users.id, u.id));
      await tx.delete(sessions).where(eq(sessions.userId, u.id));
      await retireResetLinks(tx, u.id);
      user = { id: u.id, email: u.email, name: name || u.name, role: u.role };
    }
    await tx.update(invites).set({ usedAt: now, usedBy: user.id }).where(eq(invites.id, inv.id));
    return { ok: true, kind: inv.kind, user };
  });
  if (result.ok) {
    invalidateUserCache(result.user.id);
    await recordLoginAttempt(result.user.email, "", true); // a used link counts as a sign-in: it clears the email's failure count
  }
  return result;
}

/** Retire an open link (the owner's "revoke"). */
export async function revokeInvite(id: number): Promise<void> {
  await db.update(invites).set({ expiresAt: new Date() }).where(and(eq(invites.id, id), isNull(invites.usedAt)));
}
