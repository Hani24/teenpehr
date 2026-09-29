"use client";
import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { requestTranslationAction, type RequestState } from "@/lib/translation-actions";
import type { TranslationBlockReason, TranslationStatus } from "@/lib/codes";
import { TARGET } from "./save-button";

/*
 * "Read the full article in Urdu" / "پورا مضمون اردو میں" on a story's source list (decision D9). What it
 * does depends on the item's translation: done → a link to the stored translation (instant); queued or
 * running → a link to its progress; blocked → why not, in a few words (the story's own link is right
 * there); nobody asked yet, or it failed → a button that queues it (lib/translation-actions.ts) and opens
 * the article page, which shows the progress. The story page decides which items are offered
 * (lib/translations.ts translateOffers: cited, not Urdu, an article).
 */

export type TranslateOfferView = { itemId: number; status: TranslationStatus | null; blockedReason: TranslationBlockReason | null };

export function TranslateButton({ offer, storyId }: { offer: TranslateOfferView; storyId: number }) {
  const t = useTranslations("translation");
  const href = `/article/${offer.itemId}?from=${storyId}`;
  if (offer.status === "done") {
    return <Link href={href} className={`chip ui font-semibold ${TARGET}`}><UrduMark />{t("readFull")}</Link>;
  }
  if (offer.status === "queued" || offer.status === "running") {
    return <Link href={href} className={`chip ui ${TARGET}`}><UrduMark />{t("inProgress")}</Link>;
  }
  if (offer.status === "blocked") {
    return <span className="meta ui">{t("unavailable", { reason: t(`reasonShort.${offer.blockedReason ?? "unreachable"}`) })}</span>;
  }
  return <RequestTranslationForm itemId={offer.itemId} storyId={storyId} label={t("readFull")} />;
}

/**
 * The button that asks for a translation (a first request, or again after a failure). On success the
 * action opens the article page; a refusal (today's limit reached, say) is said next to the button.
 */
export function RequestTranslationForm({ itemId, storyId, label, primary = false }: { itemId: number; storyId?: number; label: string; primary?: boolean }) {
  const t = useTranslations("translation");
  const locale = useLocale();
  const [state, action, pending] = useActionState<RequestState | { error: "offline" | "generic" }, FormData>(async (prev, form) => {
    try {
      // Resolves with nothing when the action redirected (to the article page, or to sign in).
      return (await requestTranslationAction(null, form)) ?? prev;
    } catch {
      return { error: navigator.onLine ? "generic" : "offline" };
    }
  }, null);
  const message = !state ? "" : state.error === "limit" && "limit" in state && state.limit !== undefined
    ? t("errors.limit", { limit: state.limit })
    : t(`errors.${state.error === "limit" ? "generic" : state.error}`);
  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <input type="hidden" name="item" value={itemId} />
      {storyId ? <input type="hidden" name="from" value={storyId} /> : null}
      <input type="hidden" name="locale" value={locale} />
      <button type="submit" disabled={pending} aria-busy={pending}
        className={`chip ui cursor-pointer font-semibold disabled:cursor-wait ${TARGET} ${primary ? "!border-accent !bg-accent !text-accent-ink" : ""}`}>
        {!primary && <UrduMark />}
        {pending ? t("requesting") : label}
      </button>
      {/* Always mounted, so screen readers hear the change. */}
      <span role="status" className={message ? "meta ui text-warn" : "sr-only"}>{message}</span>
    </form>
  );
}

/** A small "ا" mark: the link leads to Urdu text. Decorative; the label says it. */
function UrduMark() {
  return (
    <span aria-hidden="true" lang="ur" className="inline-flex size-[1.4em] shrink-0 items-center justify-center rounded-full border border-current text-[0.85em] leading-none">
      ا
    </span>
  );
}
