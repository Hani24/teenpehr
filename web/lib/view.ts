import type { EditionFull, StoryFull } from "./queries";
import type { Locale } from "./urdu";

export type Outlet = { name: string; perspective: string; url: string; title: string; lang: string; isPrimary: boolean; publishedAt: Date | null };

/** Unique outlets behind a story, primary first. */
export function outletsOf(story: StoryFull): Outlet[] {
  const seen = new Map<string, Outlet>();
  const sorted = [...story.sources].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  for (const s of sorted) {
    const name = s.item.source.name;
    if (!seen.has(name)) seen.set(name, { name, perspective: s.item.source.perspective, url: s.item.url, title: s.item.title, lang: s.item.lang, isPrimary: s.isPrimary, publishedAt: s.item.publishedAt });
  }
  return [...seen.values()];
}

export function primarySource(story: StoryFull) {
  return story.sources.find((s) => s.isPrimary) ?? story.sources[0];
}

/** Rough reading time from the localized text of every story. */
export function readingMinutes(ed: EditionFull, locale: Locale): number {
  const words = ed.stories.reduce((n, s) => n + (locale === "ur" ? (s.summaryUr || s.summaryEn) : s.summaryEn).split(/\s+/).length + 12, 0);
  return Math.max(1, Math.round(words / (locale === "ur" ? 160 : 220)));
}

/** Up to five must-reads across groups, in group order, for the "need to know" block. */
export function needToKnow(ed: EditionFull, max = 5): StoryFull[] {
  const order = new Map(ed.groups.map((g, i) => [g.groupId, i]));
  return ed.stories.filter((s) => s.tag === "must-read").sort((a, b) => (order.get(a.groupId) ?? 99) - (order.get(b.groupId) ?? 99) || a.order - b.order).slice(0, max);
}

export function storiesByGroup(ed: EditionFull) {
  const map = new Map<number, StoryFull[]>();
  for (const s of ed.stories) map.set(s.groupId, [...(map.get(s.groupId) ?? []), s]);
  for (const list of map.values()) list.sort((a, b) => a.order - b.order);
  return map;
}

export function distinctSourceCount(ed: EditionFull): number {
  return new Set(ed.stories.flatMap((s) => s.sources.map((x) => x.item.source.name))).size;
}

export function editionPath(date: string, slot: string) { return `/${date}/${slot}`; }
export function dateAt(date: string) { return new Date(`${date}T12:00:00+05:00`); }
