"use client";
import { useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatTime, type Locale } from "@/lib/urdu";
import { TARGET } from "./save-button";

/*
 * Says when the reader is offline, and when the page is a copy kept on this device: public/sw.js
 * serves kept pages with data-tb-cached="<when kept>" on <html>. Offline and kept: "a copy saved
 * on …". Online but kept (the network was too slow): the same, with a button to load the latest.
 * The status region is always mounted, so screen readers announce the change.
 */
function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
}
const noSubscribe = () => () => {};
const isOnline = () => navigator.onLine;
const keptAt = () => document.documentElement.getAttribute("data-tb-cached");

export function OfflineBanner() {
  const t = useTranslations("offline");
  const locale = useLocale() as Locale;
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  const kept = useSyncExternalStore(noSubscribe, keptAt, () => null);
  const at = kept ? new Date(kept) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `${formatDate(at, locale, { dateStyle: "medium" })} · ${formatTime(at, locale)}` : "";
  const show = !online || kept !== null;
  const text = kept !== null && when ? t(online ? "bannerStale" : "bannerCached", { time: when }) : !online ? t("bannerOffline") : t("bannerKept");
  return (
    <div role="status" className="no-print">
      {show && (
        <div className="border-b border-rule bg-surface-2">
          <p className="ui mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-[var(--gutter)] py-2 text-[length:var(--step--1)] text-ink">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="1.2em" height="1.2em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
              <path d="M2.5 8.5a14 14 0 0 1 19 0M5.5 12a9.5 9.5 0 0 1 13 0M8.8 15.4a4.7 4.7 0 0 1 6.4 0M12 19h.01M3 3l18 18" />
            </svg>
            <span>{text}</span>
            {online && kept !== null && (
              <button type="button" onClick={() => window.location.reload()} className={`chip cursor-pointer font-semibold ${TARGET}`}>{t("reload")}</button>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
