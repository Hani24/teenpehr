import { z } from "zod";

/*
 * A reader's display preferences (users.prefs), decision D4 in docs/PLAN.md. Safe for client
 * components: no server imports here; the Server Action that saves them is updatePrefs in
 * prefs-actions.ts.
 *
 * palette: colours only. "system" follows the device (classic when light, night when dark).
 * mode:    "wazeh" (واضح, clear) is the large-type reading mode; it combines with any palette.
 * size, contrast, nastaliq: the Wazeh controls. digits: Urdu digits, Western (latn) or Urdu (arabext).
 * images:  publisher photos on stories. "auto" shows them unless the device asks to save data
 *          (lib/media.ts imagesShown); "on" always; "off" never.
 * Stored prefs from before a field existed simply lack it and get the default.
 */
export const PALETTES = ["system", "classic", "night", "kaghaz", "sabz", "chandni", "shab"] as const;
export const READING_MODES = ["standard", "wazeh"] as const;
export const TEXT_SIZES = ["sm", "md", "lg"] as const;
export const CONTRASTS = ["normal", "high"] as const;
export const DIGIT_STYLES = ["latn", "arabext"] as const;
export const IMAGE_PREFS = ["auto", "on", "off"] as const;

export type Palette = (typeof PALETTES)[number];
export type ReadingMode = (typeof READING_MODES)[number];
export type ImagesPref = (typeof IMAGE_PREFS)[number];

const fields = {
  palette: z.enum(PALETTES),
  mode: z.enum(READING_MODES),
  size: z.enum(TEXT_SIZES),
  contrast: z.enum(CONTRASTS),
  nastaliq: z.boolean(),
  digits: z.enum(DIGIT_STYLES),
  images: z.enum(IMAGE_PREFS),
};

export const prefsSchema = z.object(fields);
export type Prefs = z.infer<typeof prefsSchema>;

/** What updatePrefs accepts: any subset of the fields, nothing else. */
export const prefsPatchSchema = z.object(fields).partial().strict();
export type PrefsPatch = z.infer<typeof prefsPatchSchema>;

export const DEFAULT_PREFS: Prefs = { palette: "system", mode: "standard", size: "md", contrast: "normal", nastaliq: false, digits: "latn", images: "auto" };

/** Only the valid fields a reader has actually set (so "unset" can fall back to a site default). */
export function storedPrefs(stored: unknown): PrefsPatch {
  const out: Record<string, unknown> = {};
  if (stored && typeof stored === "object") {
    for (const [k, schema] of Object.entries(fields)) {
      const r = schema.safeParse((stored as Record<string, unknown>)[k]);
      if (r.success) out[k] = r.data;
    }
  }
  return out as PrefsPatch;
}

/** Stored prefs over `base` (DEFAULT_PREFS, or site defaults such as the admin's Urdu digits). Never throws. */
export function parsePrefs(stored: unknown, base: Prefs = DEFAULT_PREFS): Prefs {
  return { ...base, ...storedPrefs(stored) };
}
