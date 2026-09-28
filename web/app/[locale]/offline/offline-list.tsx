"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatTime, isLocale, langAttrs, type Locale } from "@/lib/urdu";
import { listOfflinePages } from "@/components/sw-register";
import { TARGET } from "@/components/save-button";

type Page = Awaited<ReturnType<typeof listOfflinePages>>["pages"][number];

/** Reload the address the reader asked for (the offline page is served in its place). */
export function RetryButton() {
  const t = useTranslations("offline");
  return (
    <button type="button" onClick={() => window.location.reload()} className={`chip cursor-pointer font-semibold ${TARGET}`}>{t("retry")}</button>
  );
}

/** What this device keeps for offline reading, as the service worker reports it. Plain links: each is a document load the worker answers. */
export function OfflineList() {
  const t = useTranslations("offline");
  const locale = useLocale() as Locale;
  const [kept, setKept] = useState<{ loaded: boolean; pages: Page[]; updatedAt: string | null }>({ loaded: false, pages: [], updatedAt: null });
  useEffect(() => {
    let live = true;
    listOfflinePages(locale)
      .then((r) => { if (live) setKept({ loaded: true, ...r }); })
      .catch(() => { if (live) setKept({ loaded: true, pages: [], updatedAt: null }); });
    return () => { live = false; };
  }, [locale]);

  if (!kept.loaded) return null;
  if (!kept.pages.length) return <p className="card measure mt-8 p-5 text-ink-2">{t("none")}</p>;
  const at = kept.updatedAt ? new Date(kept.updatedAt) : null;
  const sections: Array<{ key: "pages" | "editions" | "savedStories" | "stories"; items: Page[] }> = [
    { key: "pages", items: kept.pages.filter((p) => p.kind === "home" || p.kind === "saved") },
    { key: "editions", items: kept.pages.filter((p) => p.kind === "edition") },
    { key: "savedStories", items: kept.pages.filter((p) => p.kind === "story" && p.saved) },
    { key: "stories", items: kept.pages.filter((p) => p.kind === "story" && !p.saved) },
  ];
  return (
    <section className="mt-8" aria-labelledby="kept">
      <h2 id="kept" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">{t("available")}</h2>
      {at && !Number.isNaN(at.getTime()) && <p className="meta mt-1">{t("updated", { time: `${formatDate(at, locale, { dateStyle: "medium" })} · ${formatTime(at, locale)}` })}</p>}
      {sections.filter((s) => s.items.length).map((s) => (
        <section key={s.key} className="mt-6" aria-labelledby={`kept-${s.key}`}>
          <h3 id={`kept-${s.key}`} className="ui text-[length:var(--step--1)] font-semibold text-accent">{t(s.key)}</h3>
          <ul className="mt-2 divide-y divide-rule">
            {s.items.map((p) => (
              <li key={p.url} className="py-2">
                <a href={p.url} {...langAttrs(p.lang && isLocale(p.lang) ? p.lang : locale, locale)} className={p.kind === "story" ? "" : "ui font-semibold"}>{p.title}</a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
