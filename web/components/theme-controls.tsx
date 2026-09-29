"use client";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { IMAGE_PREFS, parsePrefs, storedPrefs, TEXT_SIZES, type ImagesPref, type Palette, type Prefs, type PrefsPatch } from "@/lib/auth/prefs";
import { savePrefs } from "@/lib/theme-actions";
import {
  ACCOUNT_SNAPSHOT_KEY, PREF_STORAGE, SYSTEM_DARK, SYSTEM_LIGHT, THEMES, decodeLocalPrefs, encodeLocalPref, reconcilePrefs,
  renderedPrefs, resolvePrefs, themeAttrs, type AccountSnapshot, type ThemeBoot,
} from "@/lib/view";

/*
 * Display preferences (decision D4): the colour palette, the Wazeh reading mode and its text size,
 * contrast, Nastaliq, Urdu digits, and publisher images (auto/on/off, D6). On tablets and desktops
 * ThemeControls sits in the masthead bar and DisplayPanel, the full set, opens below it; on phones both
 * are hidden (ThemeControls stays mounted: it applies and syncs the choices) and the menu sheet
 * (components/site-menu.tsx) offers QuickDisplay at its top and DisplayFields further down. What is
 * applied lives on <html> (set before paint by bootScript in lib/view.ts); a choice is stored on this
 * device at once and, when signed in, saved to the account so it follows the reader. The rules for
 * which copy wins are resolvePrefs/reconcilePrefs.
 */

// ---- a small store over <html>, localStorage and the panel -------------------------------------
type Status = "idle" | "saving" | "account" | "device" | "pending" | "error";
type Ui = { open: boolean; status: Status };
const UI_START: Ui = { open: false, status: "idle" };
let ui = UI_START;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
function setUi(patch: Partial<Ui>) { ui = { ...ui, ...patch }; emit(); }

const root = () => document.documentElement;
function lsGet(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* private mode: this page still applies it */ } }
const readLocal = () => decodeLocalPrefs(lsGet);
function writeLocal(patch: PrefsPatch) {
  for (const [k, v] of Object.entries(patch) as [keyof Prefs, Prefs[keyof Prefs]][]) lsSet(PREF_STORAGE[k], encodeLocalPref(k, v));
}
function readSnapshot(): AccountSnapshot | null {
  try {
    const s = JSON.parse(lsGet(ACCOUNT_SNAPSHOT_KEY) ?? "null");
    return s && typeof s.at === "number" ? { p: storedPrefs(s.p), at: s.at, u: typeof s.u === "number" ? s.u : undefined } : null;
  } catch { return null; }
}
const writeSnapshot = (s: AccountSnapshot) => lsSet(ACCOUNT_SNAPSHOT_KEY, JSON.stringify(s));
/**
 * Merge a saved patch into the snapshot, so the next page load does not mistake it for another device's
 * change. A snapshot of another account (a shared device) is started afresh for this one.
 */
function noteSaved(patch: PrefsPatch, at: number, uid: number) {
  const prev = readSnapshot();
  const s = prev && prev.u === uid ? prev : { p: {}, at: 0 };
  writeSnapshot({ p: { ...s.p, ...patch }, at: Math.max(s.at, at), u: uid });
}
const moreContrast = () => matchMedia("(prefers-contrast: more)").matches;

/** The browser bar follows the palette's paper (with "system", whichever the device shows). */
function syncThemeColor() {
  const bg = getComputedStyle(root()).getPropertyValue("--bg").trim();
  if (bg) document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
}
function apply(p: Prefs) {
  for (const [name, value] of Object.entries(themeAttrs(p))) if (root().getAttribute(name) !== value) root().setAttribute(name, value);
  syncThemeColor();
  emit();
}
function resolveNow(boot: ThemeBoot): Prefs {
  return resolvePrefs({ site: boot.site, account: boot.account, uid: boot.uid, at: boot.at, local: readLocal(), snapshot: readSnapshot(), moreContrast: moreContrast() });
}

/** What <html> carries now, cached by its attribute values so React sees a stable object. */
let applied: { key: string; prefs: Prefs } | null = null;
function readApplied(site: Prefs): Prefs {
  const a = (name: string) => root().getAttribute(name) ?? "";
  const key = ["data-theme", "data-mode", "data-size", "data-contrast", "data-nastaliq", "data-digits", "data-images"].map(a).join("|");
  if (applied?.key !== key) {
    applied = { key, prefs: parsePrefs({ palette: a("data-theme"), mode: a("data-mode"), size: a("data-size"), contrast: a("data-contrast"), nastaliq: a("data-nastaliq") === "on", digits: a("data-digits"), images: a("data-images") }, site) };
  }
  return applied.prefs;
}
function usePrefs(boot: ThemeBoot): Prefs {
  const server = useMemo(() => renderedPrefs(boot), [boot]);
  return useSyncExternalStore(subscribe, () => readApplied(boot.site), () => server);
}
const useUi = () => useSyncExternalStore(subscribe, () => ui, () => UI_START);

/** Apply a choice now, keep it on this device, and save it to the account when signed in. */
function useChoose(boot: ThemeBoot) {
  const router = useRouter();
  return (patch: PrefsPatch) => {
    writeLocal(patch);
    apply({ ...readApplied(boot.site), ...patch });
    const uid = boot.uid;
    if (!boot.account || uid === null) { setUi({ status: "device" }); return; }
    setUi({ status: "saving" });
    savePrefs(patch).then(
      (res) => {
        if (!res.ok) { setUi({ status: res.error === "signed_out" ? "device" : "error" }); return; }
        noteSaved(patch, res.at, uid);
        setUi({ status: "account" });
        // Numbers are formatted on the server: re-render this page in the new digits.
        if (patch.digits !== undefined) router.refresh();
      },
      // Offline or the server is unreachable: the next page load pushes it (reconcilePrefs).
      () => setUi({ status: "pending" }),
    );
  };
}

function closePanel() {
  setUi({ open: false, status: "idle" });
  document.querySelector<HTMLElement>('[aria-controls="display-prefs"]')?.focus();
}

// ---- the masthead bar ---------------------------------------------------------------------------
export function ThemeControls({ boot }: { boot: ThemeBoot }) {
  const t = useTranslations();
  const prefs = usePrefs(boot);
  const { open } = useUi();
  const choose = useChoose(boot);
  const descId = useId();

  // Once per page load: meet the account (adopt what another device changed, push what could not be
  // saved), then follow other tabs and the device's contrast and colour-scheme settings.
  useEffect(() => {
    writeLocal(readLocal()); // rewrites values stored by older versions (see decodeLocalPrefs) in today's form
    const r = reconcilePrefs({ account: boot.account, uid: boot.uid, at: boot.at, local: readLocal(), snapshot: readSnapshot() });
    const uid = boot.uid;
    if (r && boot.account && uid !== null) {
      writeLocal(r.adopt);
      writeSnapshot({ p: boot.account, at: boot.at, u: uid });
      if (Object.keys(r.push).length) savePrefs(r.push).then((res) => { if (res.ok) noteSaved(r.push, res.at, uid); }, () => { /* tried again next load */ });
    }
    apply(resolveNow(boot));
    const reapply = () => apply(resolveNow(boot));
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key.startsWith("tp-")) reapply(); };
    const contrast = matchMedia("(prefers-contrast: more)");
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    window.addEventListener("storage", onStorage);
    contrast.addEventListener("change", reapply);
    scheme.addEventListener("change", syncThemeColor);
    return () => {
      window.removeEventListener("storage", onStorage);
      contrast.removeEventListener("change", reapply);
      scheme.removeEventListener("change", syncThemeColor);
    };
  }, [boot]);

  const wazeh = prefs.mode === "wazeh";
  const on = "!border-rule-strong !bg-ink !text-paper";
  const sizeNames = { sm: t("display.sizeSmall"), md: t("display.sizeMedium"), lg: t("display.sizeLarge") };
  // `contents`: the chips wrap with the rest of the masthead's row instead of as a block of their own,
  // which on a phone in Wazeh would take a line each. Wazeh and Display stay side by side; in Wazeh the
  // text sizes follow as one group, and the contrast switch shows from `sm` up (it is also in Display).
  return (
    <div className="ui contents">
      <button type="button" onClick={() => choose({ mode: wazeh ? "standard" : "wazeh" })} aria-pressed={wazeh} aria-describedby={descId} className={`chip font-semibold ${wazeh ? on : ""}`}>
        {t("wazeh.name")}
      </button>
      <span id={descId} hidden>{t("wazeh.description")}</span>
      <button type="button" onClick={() => (open ? closePanel() : setUi({ open: true, status: "idle" }))} aria-expanded={open} aria-controls="display-prefs" className={`chip font-semibold ${open ? on : ""}`}>
        {t("display.open")}
      </button>
      {wazeh && (
        <>
          <div role="group" aria-label={t("nav.textSize")} className="flex flex-wrap items-center gap-1">
            {TEXT_SIZES.map((s) => (
              <button key={s} type="button" onClick={() => choose({ size: s })} aria-pressed={prefs.size === s} className={`chip font-semibold ${prefs.size === s ? on : ""}`}>
                {t(`wazeh.${s === "sm" ? "sizeSmall" : s === "md" ? "sizeMedium" : "sizeLarge"}`)}<span className="sr-only"> ({sizeNames[s]})</span>
              </button>
            ))}
          </div>
          <button type="button" onClick={() => choose({ contrast: prefs.contrast === "high" ? "normal" : "high" })} aria-pressed={prefs.contrast === "high"} className={`chip max-sm:hidden! ${prefs.contrast === "high" ? on : ""}`}>
            {t("display.contrastHigh")}
          </button>
        </>
      )}
    </div>
  );
}

// ---- the full set, below the bar ----------------------------------------------------------------
function Swatch({ id }: { id: Palette }) {
  if (id === "system") {
    return <span className="swatch-pair" aria-hidden="true"><span className="swatch" data-swatch={SYSTEM_LIGHT} /><span className="swatch" data-swatch={SYSTEM_DARK} /></span>;
  }
  return <span className="swatch" data-swatch={id} aria-hidden="true" />;
}

function Choice({ name, checked, onChange, children, type = "radio" }: { name?: string; checked: boolean; onChange: () => void; children: React.ReactNode; type?: "radio" | "checkbox" }) {
  return (
    <label className="opt">
      <input type={type} name={name} checked={checked} onChange={onChange} />
      {children}
    </label>
  );
}
function Label({ title, hint }: { title: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <span className="opt-text">
      <span className="block font-semibold">{title}</span>
      {hint && <span className="meta block">{hint}</span>}
    </span>
  );
}

export function DisplayPanel({ boot }: { boot: ThemeBoot }) {
  const t = useTranslations();
  const { open } = useUi();
  const id = useId();
  // The panel is rendered below the whole bar, after the account menu: focus moves into it on opening,
  // so the next Tab after "Display" is not the account menu (Escape and Done bring it back).
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (open) heading.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <section id="display-prefs" aria-labelledby={`${id}-h`} className="no-print mx-auto max-w-6xl px-[var(--gutter)] pb-4"
      onKeyDown={(e) => { if (e.key === "Escape") closePanel(); }}>
      <div className="card grid gap-6 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${id}-h`} ref={heading} tabIndex={-1} className="ui text-[length:var(--step-1)] font-bold focus:outline-none">{t("display.title")}</h2>
          <button type="button" onClick={closePanel} className="chip font-semibold">{t("display.done")}</button>
        </div>
        <DisplayFields boot={boot} />
      </div>
    </section>
  );
}

// ---- the phone menu's share (components/site-menu.tsx) ------------------------------------------
/**
 * The first controls of the phone menu, one tap after Menu: in Wazeh its text size, then Wazeh on or
 * off (always shown, so the switch keeps focus when it changes the mode). The other display choices
 * follow lower in the menu (DisplayFields with `omitQuick`), so none is offered twice.
 */
export function QuickDisplay({ boot }: { boot: ThemeBoot }) {
  const t = useTranslations();
  const prefs = usePrefs(boot);
  const choose = useChoose(boot);
  const id = useId();
  const wazeh = prefs.mode === "wazeh";
  const ur = (chunks: React.ReactNode) => <span lang="ur">{chunks}</span>;
  const sizeNames = { sm: t("display.sizeSmall"), md: t("display.sizeMedium"), lg: t("display.sizeLarge") };
  return (
    <div className="grid gap-4">
      {wazeh && (
        <div role="group" aria-labelledby={`${id}-size`}>
          <p id={`${id}-size`} className="sheet-heading">{t("nav.textSize")}</p>
          <div className="sheet-sizes">
            {TEXT_SIZES.map((s) => (
              <button key={s} type="button" onClick={() => choose({ size: s })} aria-pressed={prefs.size === s} className="sheet-size" data-step={s}>
                <span aria-hidden="true" className="sheet-size-glyph">{t(`wazeh.${s === "sm" ? "sizeSmall" : s === "md" ? "sizeMedium" : "sizeLarge"}`)}</span>
                <span className="sheet-size-name">{sizeNames[s]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <Choice type="checkbox" checked={wazeh} onChange={() => choose({ mode: wazeh ? "standard" : "wazeh" })}>
        <Label title={t.rich("wazeh.label", { ur })} hint={t("wazeh.description")} />
      </Choice>
    </div>
  );
}

/**
 * Every display choice as fieldsets, with the line that says where a choice was saved. The Display panel
 * shows them all; the phone menu passes `omitQuick`, leaving out the reading mode and the text size,
 * which QuickDisplay already offers at its top.
 */
export function DisplayFields({ boot, omitQuick = false }: { boot: ThemeBoot; omitQuick?: boolean }) {
  const t = useTranslations();
  const prefs = usePrefs(boot);
  const { status } = useUi();
  const choose = useChoose(boot);
  const id = useId();
  const wazeh = prefs.mode === "wazeh";
  const legend = "ui mb-2 font-semibold";
  // Images: story pictures follow this at once (components/story-image-view.tsx watches <html data-images>).
  const imageChoice: Record<ImagesPref, { title: string; hint: string }> = {
    auto: { title: t("images.prefAuto"), hint: t("images.prefAutoHint") },
    on: { title: t("images.prefOn"), hint: t("images.prefOnHint") },
    off: { title: t("images.prefOff"), hint: t("images.prefOffHint") },
  };
  const ur = (chunks: React.ReactNode) => <span lang="ur">{chunks}</span>;
  const message = status === "idle" ? "" : t(`display.status.${status}`);
  return (
    <>
      <fieldset className="min-w-0">
        <legend className={legend}>{t("display.palette")}</legend>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2">
          {THEMES.map((th) => (
            <Choice key={th.id} name={`${id}-palette`} checked={prefs.palette === th.id} onChange={() => choose({ palette: th.id })}>
              <Swatch id={th.id} />
              <Label title={t(`themes.${th.id}`)} hint={t(`themes.${th.id}Hint`)} />
            </Choice>
          ))}
        </div>
      </fieldset>

      {!omitQuick && (
        <fieldset className="min-w-0">
          <legend className={legend}>{t("display.mode")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <Choice name={`${id}-mode`} checked={!wazeh} onChange={() => choose({ mode: "standard" })}>
              <Label title={t("display.standard")} hint={t("display.standardHint")} />
            </Choice>
            <Choice name={`${id}-mode`} checked={wazeh} onChange={() => choose({ mode: "wazeh" })}>
              <Label title={t.rich("wazeh.label", { ur })} hint={t("wazeh.description")} />
            </Choice>
          </div>
        </fieldset>
      )}

      {!omitQuick && wazeh && (
        <fieldset className="min-w-0">
          <legend className={legend}>{t("nav.textSize")}</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
            {TEXT_SIZES.map((s) => (
              <Choice key={s} name={`${id}-size`} checked={prefs.size === s} onChange={() => choose({ size: s })}>
                <Label title={t(`wazeh.${s === "sm" ? "sizeSmall" : s === "md" ? "sizeMedium" : "sizeLarge"}`)} hint={t(`display.${s === "sm" ? "sizeSmall" : s === "md" ? "sizeMedium" : "sizeLarge"}`)} />
              </Choice>
            ))}
          </div>
        </fieldset>
      )}

      {wazeh && (
        <fieldset className="min-w-0">
          <legend className={legend}>{t("display.urduBody")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <Choice name={`${id}-script`} checked={!prefs.nastaliq} onChange={() => choose({ nastaliq: false })}>
              <Label title={<span lang="ur" className="sample-naskh">{t("display.naskh")}</span>} hint={t("display.naskhHint")} />
            </Choice>
            <Choice name={`${id}-script`} checked={prefs.nastaliq} onChange={() => choose({ nastaliq: true })}>
              <Label title={<span lang="ur" className="sample-nastaliq">{t("display.nastaliq")}</span>} hint={t("display.nastaliqHint")} />
            </Choice>
          </div>
        </fieldset>
      )}

      <fieldset className="min-w-0">
        <legend className={legend}>{t("images.prefTitle")}</legend>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2">
          {IMAGE_PREFS.map((v) => (
            <Choice key={v} name={`${id}-images`} checked={prefs.images === v} onChange={() => choose({ images: v })}>
              <Label title={imageChoice[v].title} hint={imageChoice[v].hint} />
            </Choice>
          ))}
        </div>
      </fieldset>

      <fieldset className="min-w-0">
        <legend className={legend}>{t("display.contrast")}</legend>
        <Choice type="checkbox" checked={prefs.contrast === "high"} onChange={() => choose({ contrast: prefs.contrast === "high" ? "normal" : "high" })}>
          <Label title={t("display.contrastHigh")} hint={t("display.contrastHint")} />
        </Choice>
      </fieldset>

      <fieldset className="min-w-0">
        <legend className={legend}>{t("display.digits")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice name={`${id}-digits`} checked={prefs.digits === "latn"} onChange={() => choose({ digits: "latn" })}>
            <Label title={t("display.digitsLatn")} hint={<bdi dir="ltr" lang="en">1 2 3</bdi>} />
          </Choice>
          <Choice name={`${id}-digits`} checked={prefs.digits === "arabext"} onChange={() => choose({ digits: "arabext" })}>
            <Label title={t("display.digitsArabext")} hint={<span lang="ur">۱ ۲ ۳</span>} />
          </Choice>
        </div>
      </fieldset>

      <p role="status" className={`meta min-h-[1.6em] ${status === "error" ? "!text-accent" : ""}`}>{message}</p>
    </>
  );
}
