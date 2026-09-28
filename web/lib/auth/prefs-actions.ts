"use server";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser } from "./index";
import { parsePrefs, prefsPatchSchema, type Prefs, type PrefsPatch } from "./prefs";
import { invalidateUserCache } from "./session-store";

/**
 * Save part of the signed-in reader's preferences (a jsonb merge, so two tabs changing different
 * fields never undo each other). Returns the full preferences after the change.
 */
export async function updatePrefs(patch: PrefsPatch): Promise<{ ok: true; prefs: Prefs } | { ok: false; error: "signed_out" | "invalid" }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "signed_out" };
  const parsed = prefsPatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { users } = schema;
  const [row] = await db.update(users).set({ prefs: sql`${users.prefs} || ${JSON.stringify(parsed.data)}::jsonb` })
    .where(eq(users.id, user.id)).returning({ prefs: users.prefs });
  invalidateUserCache(user.id);
  return { ok: true, prefs: parsePrefs(row?.prefs) };
}
