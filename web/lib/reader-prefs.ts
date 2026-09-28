import "server-only";
import { cache } from "react";
import { getCurrentUser } from "@/lib/auth";
import { storedPrefs } from "@/lib/auth/prefs";
import { getCachedSettings } from "@/lib/queries";
import type { UrduDigits } from "@/lib/urdu";
import { renderedPrefs, siteThemeDefaults, type ThemeBoot } from "@/lib/view";

/**
 * The display preferences this request renders with (decision D4): the site defaults from Settings,
 * the signed-in reader's stored choices (null when signed out) and when they were read, which the
 * boot script and components/theme-controls.tsx use to tell a fresh page from one served from the
 * offline cache. Deduplicated per request, so the layout's <html> and the masthead agree.
 * Reading the session makes the pages that use it render per request.
 */
export const getThemeBoot = cache(async (): Promise<ThemeBoot> => {
  const [settings, user] = await Promise.all([getCachedSettings(), getCurrentUser()]);
  return { site: siteThemeDefaults(settings), account: user ? storedPrefs(user.prefs) : null, uid: user?.id ?? null, at: Date.now() };
});

/** Urdu digits for this reader: their own choice, else the site's (Settings); getSitePrefs().digitsUr is the same value. */
export async function readerDigits(): Promise<UrduDigits> {
  return renderedPrefs(await getThemeBoot()).digits;
}
