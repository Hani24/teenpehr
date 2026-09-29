"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { pollTranslation } from "@/lib/translation-actions";
import type { TranslationPoll } from "@/lib/translations";
import { localDigits, type Locale, type UrduDigits } from "@/lib/urdu";
import { TARGET } from "@/components/save-button";

/*
 * The article page's progress while a translation is queued or running (decision D9). It asks the server
 * (pollTranslation) every few seconds, less often as time passes, and not while the tab is hidden; when
 * the translation is done, blocked or failed it refreshes the page, which then shows the text or the
 * reason. "Check now" asks at once. Without scripts the page still says where the request stands, and a
 * reload shows the latest.
 */

const TERMINAL = new Set(["done", "failed", "blocked"]);
/** Seconds between checks: often at first, then less, so a queue that waits for the translator is cheap. */
const delayFor = (elapsedMs: number) => (elapsedMs < 60_000 ? 4 : elapsedMs < 10 * 60_000 ? 10 : 30) * 1000;

export function TranslationLive({ itemId, fromId, initial, digits }: { itemId: number; fromId?: number; initial: TranslationPoll; digits?: UrduDigits }) {
  const t = useTranslations("translation");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [state, setState] = useState<TranslationPoll>(initial);
  const [problem, setProblem] = useState<"poll" | "signed_out" | null>(null);
  const [checking, setChecking] = useState(false);
  const started = useRef<number | null>(null);
  const refreshed = useRef(false);
  const timer = useRef<number | null>(null);
  const num = (s: string) => localDigits(s, locale, digits);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const r = await pollTranslation(itemId);
      if (r.status === "signed_out") { setProblem("signed_out"); return false; }
      if (r.status === "invalid") { setProblem("poll"); return false; }
      setProblem(null);
      setState(r);
      return true;
    } catch {
      setProblem("poll");
      return true;
    } finally {
      setChecking(false);
    }
  }, [itemId]);

  // The terminal states are the page's to show: refresh once to render them on the server.
  useEffect(() => {
    if (TERMINAL.has(state.status) && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [state.status, router]);

  useEffect(() => {
    if (TERMINAL.has(state.status) || problem === "signed_out") return;
    started.current ??= Date.now();
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      timer.current = window.setTimeout(async () => {
        if (cancelled) return;
        if (document.visibilityState === "hidden") return; // resumed by the visibility handler
        const keepGoing = await check();
        if (keepGoing) schedule();
      }, delayFor(Date.now() - (started.current ?? Date.now())));
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      if (timer.current) window.clearTimeout(timer.current);
      void check().then((go) => { if (go) schedule(); });
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state.status, problem, check]);

  const headline = state.status === "running" ? t("running")
    : state.status === "queued" ? `${t("queued")}${state.position ? ` ${t("position", { position: state.position })}` : ""}`
    : state.status === "done" ? t("done") : "";

  return (
    <section className="card mt-6 p-4" aria-labelledby="tr-status-h">
      <h2 id="tr-status-h" className="ui font-semibold">{t("statusHeading")}</h2>
      <p className="mt-2 flex items-center gap-2" role="status">
        {!TERMINAL.has(state.status) && <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />}
        <span>{num(headline)}</span>
      </p>
      {state.status !== "done" && (
        <p className="meta mt-1">{state.waitMin ? num(t("wait", { minutes: state.waitMin })) : t("waitUnknown")}</p>
      )}
      {state.retrying && state.status !== "done" && <p className="meta mt-1">{t("retrying")}</p>}
      {state.stale && state.status === "queued" && <p className="mt-2 text-warn">{t("stale")}</p>}
      {state.status === "done" ? (
        // The refresh shows the text; this link is for when it could not (a slow or lost connection).
        <p className="ui mt-3"><a href={`/${locale}/article/${itemId}${fromId ? `?from=${fromId}` : ""}`} className="font-semibold">{t("showIt")}</a></p>
      ) : (
        <>
          <p className="meta mt-2">{t("leave")}</p>
          <p className="ui mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" onClick={() => void check()} disabled={checking} aria-busy={checking} className={`chip cursor-pointer font-semibold disabled:cursor-wait ${TARGET}`}>
              {t("checkNow")}
            </button>
            {problem === "poll" && <span className="meta text-warn">{t("pollError")}</span>}
          </p>
        </>
      )}
      {problem === "signed_out" && (
        <p className="mt-3 text-warn">
          <a href={`/${locale}/login?next=${encodeURIComponent(`/${locale}/article/${itemId}`)}`}>{t("signedOut")}</a>
        </p>
      )}
    </section>
  );
}
