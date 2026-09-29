"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { requestTranslation, translationPoll, type RequestError, type TranslationPoll } from "./translations";

/*
 * Server Actions for full-article Urdu translations (decision D9; the rules are in lib/translations.ts).
 * requestTranslationAction is a form action (it works before the page's scripts load): it queues the
 * translation and opens the article page; pollTranslation is what that page calls while it waits.
 */

const id = z.coerce.number().int().positive().max(2_147_483_647);
const requestSchema = z.object({
  item: id,
  // The story the reader came from, for the article page's way back; a bad one is dropped, not an error.
  from: id.optional().catch(undefined),
  locale: z.enum(["en", "ur"]),
}).strict();

export type RequestState = { error: RequestError | "invalid"; limit?: number } | null;

/** The article page for an item, with the story the reader came from. */
function articlePath(locale: "en" | "ur", item: number, from?: number) {
  return `/${locale}/article/${item}${from ? `?from=${from}` : ""}`;
}

/** Form action: ask for the full Urdu translation of a cited item, then open its page (which shows the progress). */
export async function requestTranslationAction(_prev: RequestState, form: FormData): Promise<RequestState> {
  const p = requestSchema.safeParse({ item: form.get("item"), from: form.get("from") || undefined, locale: form.get("locale") });
  if (!p.success) return { error: "invalid" };
  const { item, from, locale } = p.data;
  const user = await requireUser({ locale, next: articlePath(locale, item, from) });
  const r = await requestTranslation(user, item);
  if (!r.ok) return { error: r.error, ...(r.limit !== undefined ? { limit: r.limit } : {}) };
  redirect(articlePath(locale, item, from));
}

/** The translation's progress for the article page's live status; `signed_out` when the session ended meanwhile. */
export async function pollTranslation(itemId: number): Promise<TranslationPoll | { status: "signed_out" } | { status: "invalid" }> {
  const p = id.safeParse(itemId);
  if (!p.success) return { status: "invalid" };
  if (!(await getCurrentUser())) return { status: "signed_out" };
  return translationPoll(p.data);
}
