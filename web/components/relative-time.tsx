"use client";
import { useSyncExternalStore } from "react";
import { formatDate, formatTime, relativeTime, type Locale, type UrduDigits } from "@/lib/urdu";

/*
 * "3 hours ago", computed in the reader's browser. Edition and story pages are cached for up to an
 * hour (ISR), so a label rendered on the server would be frozen at render time. The server (and
 * the first client render, so hydration matches) shows the absolute time instead; the relative
 * label replaces it after hydration and moves on every minute.
 */
const MINUTE = 60_000;
function subscribe(cb: () => void) {
  const id = window.setInterval(cb, MINUTE);
  return () => window.clearInterval(id);
}
const nowMinute = () => Math.floor(Date.now() / MINUTE);
const serverMinute = () => null;

export function RelativeTime({ iso, locale, digits, absolute = true, prefix = "", className }:
  { iso: string; locale: Locale; digits?: UrduDigits; absolute?: boolean; prefix?: string; className?: string }) {
  const minute = useSyncExternalStore(subscribe, nowMinute, serverMinute);
  const at = new Date(iso);
  const full = `${formatDate(at, locale, { dateStyle: "medium" }, digits)} · ${formatTime(at, locale, digits)}`;
  const text = minute === null ? (absolute ? full : "") : relativeTime(at, new Date(minute * MINUTE), locale, digits);
  if (!text) return null;
  return <>{prefix}<time dateTime={iso} title={full} className={className}>{text}</time></>;
}
