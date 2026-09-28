"use server";
import { updatePrefs } from "@/lib/auth/prefs-actions";
import type { PrefsPatch } from "@/lib/auth/prefs";

/**
 * Save display preferences to the signed-in reader's account (updatePrefs validates the patch with
 * zod), stamped with the server's clock so the device can tell newer account copies from older ones
 * (see reconcilePrefs in lib/view.ts).
 */
export async function savePrefs(patch: PrefsPatch) {
  const res = await updatePrefs(patch);
  return { ...res, at: Date.now() };
}
