"use client";
import { useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { IMAGE_PREFS, type ImagesPref } from "@/lib/auth/prefs";
import { imagesShown } from "@/lib/media";

/*
 * A story's publisher image on the page (decisions I3–I5, D6 in docs/PLAN.md). The server wrapper,
 * components/story-image.tsx, decides which image, its alt text and its credit; this part decides
 * whether this device may load it, and handles "tap to show" for sensitive images.
 *
 * No request before the reader's choice is known: the server render and the first client render
 * (hydration) carry only the frame (its dominant colour, at the image's shape) and the credit, never an
 * <img>. Once hydrated, the component reads <html data-images, data-save-data, data-mode> (set before
 * paint by the boot script in lib/view.ts) and only then adds the <img>, if images are on for this
 * device. With images off (or "auto" on a device saving data) globals.css hides the frame from the first
 * paint and this renders nothing: nothing is downloaded. It follows changes live (the Display panel).
 *
 * A `graphic` image is blurred behind a large "Sensitive image — tap to show" button; in Wazeh it is not
 * loaded at all until tapped (globals.css shows just the button there, from the first paint, since the
 * server render already marks it data-covered). Nothing is remembered: the next page asks again.
 */

export type StoryImageVariant = "lead" | "thumb" | "hero" | "print";

export type StoryImageData = {
  src: string;
  srcSet: string;
  width: number;
  height: number;
  /** The frame's aspect ratio (width / height); the image is cropped to it (object-fit: cover). */
  ratio: number;
  /** Dominant colour, "#rrggbb": the frame's background until (or instead of) the image. */
  color: string;
  /** The publisher's own alt text, or "Image from <outlet>" (never machine-written). */
  alt: string;
  /** Language of `alt` when it differs from the page's (a publisher's English alt on an Urdu page). */
  altLang?: "en" | "ur";
  /** The outlet as this page names it (the glossary's Urdu name on Urdu pages when there is one). */
  outlet: string;
  outletLang: "en" | "ur";
  /** The cited article (or post) the image came from, http(s): the credit always links there (I3). */
  creditUrl: string;
  graphic: boolean;
};

// ---- <html> attributes as a store (one observer for every image on the page) ---------------------
const ATTRS = ["data-images", "data-save-data", "data-mode"] as const;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!observer) {
    observer = new MutationObserver(() => listeners.forEach((l) => l()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [...ATTRS] });
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size) { observer?.disconnect(); observer = null; }
  };
}
/** A string, so React compares it by value; never "" on the client (the server's "unknown"). */
function snapshot(): string {
  const d = document.documentElement;
  return ATTRS.map((a) => d.getAttribute(a) ?? "").join("|");
}
const serverSnapshot = () => "";

function parse(snap: string): { known: boolean; pref: ImagesPref; saveData: boolean; wazeh: boolean } {
  if (!snap) return { known: false, pref: "auto", saveData: false, wazeh: false };
  const [images, saveData, mode] = snap.split("|");
  const pref = (IMAGE_PREFS as readonly string[]).includes(images) ? (images as ImagesPref) : "auto";
  return { known: true, pref, saveData: saveData === "on", wazeh: mode === "wazeh" };
}

/**
 * `sizes` per slot and mode (the image is only added on the client, so it can follow the reading mode).
 * Lazy images lead with "auto": browsers that support it use the laid-out width.
 */
function sizesFor(variant: StoryImageVariant, wazeh: boolean, lazy: boolean): string {
  const s = wazeh
    ? "(min-width: 72rem) 44rem, calc(100vw - 3rem)"
    : variant === "thumb" ? "9rem"
      : variant === "lead" ? "(min-width: 48rem) 34rem, calc(100vw - 2rem)"
        : variant === "hero" ? "(min-width: 50rem) 45rem, calc(100vw - 2rem)"
          : "(min-width: 50rem) 20rem, 45vw";
  return lazy ? `auto, ${s}` : s;
}

export function StoryImageView({ data, variant, priority = false, saveDataHint = false }:
  { data: StoryImageData; variant: StoryImageVariant; priority?: boolean; saveDataHint?: boolean }) {
  const t = useTranslations("images");
  const env = parse(useSyncExternalStore(subscribe, snapshot, serverSnapshot));
  const [revealed, setRevealed] = useState(false);
  const [lit, setLit] = useState(false);
  // A wide variant that fails (offline: the service worker keeps the 480 px files) is retried once as the
  // narrowest one alone; if that fails too, the frame keeps its colour and the credit, with no broken icon.
  const [narrow, setNarrow] = useState(false);
  const [failed, setFailed] = useState(false);
  const onError = () => (!narrow && data.srcSet.includes(",") ? setNarrow(true) : setFailed(true));
  const figure = useRef<HTMLElement>(null);

  // The Save-Data request header (saveDataHint) counts like navigator.connection.saveData.
  const allowed = env.known && imagesShown(env.pref, env.saveData || saveDataHint);
  if (env.known && !allowed) return null;

  const covered = data.graphic && !revealed;
  // Wazeh: a sensitive image is not even loaded until the reader asks for it.
  const withheld = covered && env.wazeh;
  // The print page loads every picture at once: printing does not wait for lazy ones.
  const lazy = !priority && variant !== "print";
  const reveal = () => {
    setRevealed(true);
    // The button goes away: focus lands on the figure, which names the image through its caption.
    requestAnimationFrame(() => figure.current?.focus());
  };
  const style = { "--fig-ratio": String(data.ratio), "--fig-bg": data.color } as CSSProperties;

  return (
    // data-save-data: the request said Save-Data: on, so with images on "auto" globals.css hides the frame
    // from the first paint, as it does for navigator.connection.saveData (<html data-save-data>).
    <figure ref={figure} tabIndex={-1} className={`story-fig story-fig-${variant}`} style={style} data-save-data={saveDataHint ? "on" : undefined}
      data-graphic={data.graphic || undefined} data-covered={covered || undefined} data-withheld={withheld || undefined} data-lit={lit || undefined}>
      <div className="story-fig-frame" onPointerDown={() => setLit(true)}>
        {allowed && !withheld && !failed && (
          // A plain <img>: the variants are already sized WebP files behind the login wall; next/image would
          // re-encode them and serve them from its own cache.
          // eslint-disable-next-line @next/next/no-img-element
          <img key={narrow ? "narrow" : "all"} className="story-fig-img" src={data.src} srcSet={narrow ? undefined : data.srcSet} sizes={narrow ? undefined : sizesFor(variant, env.wazeh, lazy)}
            width={data.width} height={data.height} alt={data.alt} lang={data.altLang} dir={data.altLang ? (data.altLang === "ur" ? "rtl" : "ltr") : undefined}
            loading={lazy ? "lazy" : "eager"} fetchPriority={priority ? "high" : undefined} decoding="async"
            aria-hidden={covered || undefined} draggable={false} onError={onError} />
        )}
        {covered && (
          <button type="button" className="story-fig-reveal ui" onClick={reveal}>
            <EyeIcon />
            <span>{t("sensitive")}</span>
          </button>
        )}
      </div>
      <figcaption className="story-fig-credit meta">
        {t.rich("credit", {
          outlet: data.outlet,
          o: (chunks) => <a href={data.creditUrl} target="_blank" rel="noopener noreferrer" lang={data.outletLang} dir={data.outletLang === "ur" ? "rtl" : "ltr"} className={data.outletLang === "en" ? "latin" : undefined}>{chunks}</a>,
        })}
      </figcaption>
    </figure>
  );
}

function EyeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="1.4em" height="1.4em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
