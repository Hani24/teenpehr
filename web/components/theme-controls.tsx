"use client";
import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

type Theme = "classic" | "night" | "buzurg" | "system";
type Size = "sm" | "md" | "lg";

/** Tiny external store over localStorage so reads never happen in effects and SSR stays deterministic. */
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { listeners.delete(cb); window.removeEventListener("storage", cb); };
}
function emit() { listeners.forEach((l) => l()); }
function read(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function write(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* private mode */ } emit(); }
function useStored(key: string, fallback: string) {
  return useSyncExternalStore(subscribe, () => read(key, fallback), () => fallback);
}

const root = () => document.documentElement;
function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "classic") : theme;
  root().setAttribute("data-theme", resolved);
}

export function ThemeControls() {
  const t = useTranslations();
  const theme = useStored("tp-theme", "system") as Theme;
  const size = useStored("tp-size", "md") as Size;
  const contrast = useStored("tp-contrast", "") === "high";
  const nastaliq = useStored("tp-nastaliq", "") === "1";

  const chooseTheme = (next: Theme) => { write("tp-theme", next); applyTheme(next); };
  const chooseSize = (next: Size) => { write("tp-size", next); root().setAttribute("data-size", next); };
  const toggleContrast = () => {
    const next = !contrast; write("tp-contrast", next ? "high" : "");
    if (next) root().setAttribute("data-contrast", "high"); else root().removeAttribute("data-contrast");
  };
  const toggleNastaliq = () => {
    const next = !nastaliq; write("tp-nastaliq", next ? "1" : "");
    root().classList.toggle("nastaliq", next);
  };

  const on = "!border-rule-strong !bg-ink !text-paper";
  return (
    <div className="ui flex flex-wrap items-center gap-2">
      <select value={theme} onChange={(e) => chooseTheme(e.target.value as Theme)} className="chip cursor-pointer appearance-none pe-6" aria-label={t("nav.theme")}>
        <option value="system">{t("themes.system")}</option>
        <option value="classic">{t("themes.classic")}</option>
        <option value="night">{t("themes.night")}</option>
        <option value="buzurg">{t("themes.buzurg")} · {t("buzurg.name")}</option>
      </select>
      {theme === "buzurg" && (
        <>
          <div role="group" aria-label={t("nav.textSize")} className="flex items-center gap-1">
            {(["sm", "md", "lg"] as Size[]).map((s, i) => (
              <button key={s} type="button" onClick={() => chooseSize(s)} aria-pressed={size === s} className={`chip font-semibold ${size === s ? on : ""}`}>
                {[t("buzurg.sizeSmall"), t("buzurg.sizeMedium"), t("buzurg.sizeLarge")][i]}
              </button>
            ))}
          </div>
          <button type="button" onClick={toggleContrast} aria-pressed={contrast} className={`chip ${contrast ? on : ""}`}>{t("nav.contrast")}</button>
          <button type="button" onClick={toggleNastaliq} aria-pressed={nastaliq} className={`chip ${nastaliq ? on : ""}`} lang="ur">نستعلیق</button>
        </>
      )}
    </div>
  );
}
