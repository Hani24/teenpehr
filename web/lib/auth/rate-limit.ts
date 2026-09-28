import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";

/*
 * Sign-in throttle over login_attempts, in a 15-minute window: at most 5 failures for one email from
 * one IP, 20 for one email from all IPs together, and 20 from one IP. A successful sign-in clears its
 * email's counts (not its IP's, or one good account would unlock guessing at every other).
 *
 * Per email and IP first, so a stranger who knows a member's email cannot lock them out with five bad
 * tries from one address: it takes 20 from more than one address, and the per-IP limit caps each.
 * The looser per-email total still stops guessing spread over many addresses. An owner's reset link
 * (lib/auth/invites.ts) records a success, which unlocks the email at once. An unknown IP ("") is
 * not limited by IP, so a proxy that hides client addresses cannot lock everyone out at once.
 *
 * Check and record are one step (reserveLoginAttempt): an attempt is stored as a failure, under a lock
 * every reservation takes, before its password is checked, and marked a success afterwards. So a
 * burst of parallel guesses queues on the lock and each one counts the ones before it; checking
 * first and recording after the ~50 ms scrypt would let a whole burst through at a count of zero.
 *
 * Rows older than KEEP_DAYS are deleted on each successful sign-in, so the table stays bounded.
 */
export const LOGIN_WINDOW_MINUTES = 15;
export const MAX_FAILURES_PER_EMAIL_AND_IP = 5;
export const MAX_FAILURES_PER_EMAIL = 20;
export const MAX_FAILURES_PER_IP = 20;
const KEEP_DAYS = 90;
/** One advisory lock for every reservation: the critical section is two small queries, not the hash. */
const ATTEMPTS_LOCK = sql`select pg_advisory_xact_lock(hashtext('tabayyun:login-attempts'))`;

const { loginAttempts: a } = schema;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Email as stored everywhere: trimmed, NFC, lowercase (Postgres lower() in SQL, which the table's check uses). */
function norm(email: string): string {
  return email.normalize("NFC").trim().toLowerCase().slice(0, 320);
}

async function underLimits(q: typeof db | Tx, e: string, ip: string): Promise<boolean> {
  const since = sql`now() - make_interval(mins => ${LOGIN_WINDOW_MINUTES})`;
  const lastOk = sql`(select max(${a.at}) from ${a} where ${a.email} = lower(${e}) and ${a.ok})`;
  const mine = sql`${a.email} = lower(${e}) and ${a.at} > coalesce(${lastOk}, '-infinity')`;
  const [row] = await q.select({
    byEmailIp: sql<number>`count(*) filter (where ${mine} and ${a.ip} = ${ip})::int`,
    byEmail: sql<number>`count(*) filter (where ${mine})::int`,
    byIp: sql<number>`count(*) filter (where ${a.ip} = ${ip} and ${ip} <> '')::int`,
  }).from(a).where(sql`${a.at} > ${since} and not ${a.ok} and (${a.email} = lower(${e}) or ${a.ip} = ${ip})`);
  return (row?.byEmailIp ?? 0) < MAX_FAILURES_PER_EMAIL_AND_IP && (row?.byEmail ?? 0) < MAX_FAILURES_PER_EMAIL
    && (row?.byIp ?? 0) < MAX_FAILURES_PER_IP;
}

/** Whether another attempt would be allowed now (a read only: sign-in itself uses reserveLoginAttempt). */
export async function loginAllowed(email: string, ip: string): Promise<boolean> {
  return underLimits(db, norm(email), ip.slice(0, 64));
}

/**
 * Check the limits and, when they allow another try, record it as a failure, atomically. Returns the
 * attempt's id (pass it to loginSucceeded once the password is right), or null when rate limited.
 * The timestamp is taken after the lock, so attempts are ordered as they were admitted.
 */
export async function reserveLoginAttempt(email: string, ip: string): Promise<number | null> {
  const e = norm(email), addr = ip.slice(0, 64);
  return db.transaction(async (tx) => {
    await tx.execute(ATTEMPTS_LOCK);
    if (!(await underLimits(tx, e, addr))) return null;
    const [row] = await tx.insert(a).values({ email: sql`lower(${e})`, ip: addr, ok: false, at: sql`clock_timestamp()` }).returning({ id: a.id });
    return row.id;
  });
}

/** The reserved attempt was a successful sign-in: it clears its email's failure count. */
export async function loginSucceeded(attemptId: number): Promise<void> {
  await db.update(a).set({ ok: true }).where(eq(a.id, attemptId));
  await db.delete(a).where(sql`${a.at} < now() - make_interval(days => ${KEEP_DAYS})`);
}

/** Record a finished attempt that needed no reservation (a used invite or reset link records a success). */
export async function recordLoginAttempt(email: string, ip: string, ok: boolean): Promise<void> {
  await db.insert(a).values({ email: sql`lower(${norm(email)})`, ip: ip.slice(0, 64), ok });
  if (ok) await db.delete(a).where(sql`${a.at} < now() - make_interval(days => ${KEEP_DAYS})`);
}
