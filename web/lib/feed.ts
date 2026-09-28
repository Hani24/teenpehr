import "server-only";
import { getTranslations } from "next-intl/server";
import { listPublishedEditions, getEditionFull, getCachedSettings } from "./queries";
import { isLocale, picked, slotNames, type Locale, type Slot } from "./urdu";
import { outletsOf } from "./view";

/*
 * The feeds carry the last FEED_EDITIONS published editions (three days at three a day), newest
 * first, so a reader that polls less often than editions come out still sees every story, and the
 * feed is never empty after a quiet spell. Each item's id/guid is the story's permalink, which
 * never changes once its edition is published.
 */
const FEED_EDITIONS = 9;

export async function buildFeed(localeParam: string) {
  const locale = (isLocale(localeParam) ? localeParam : "en") as Locale;
  const [list, settings, ts] = await Promise.all([
    listPublishedEditions(FEED_EDITIONS),
    getCachedSettings(),
    getTranslations({ locale, namespace: "site" }),
  ]);
  const editions = (await Promise.all(list.map((e) => getEditionFull(e.date, e.slot as Slot)))).filter((e) => e !== null);
  const site = process.env.SITE_URL ?? "http://localhost:3000";
  const configured = locale === "ur" ? settings.site_name_ur : settings.site_name_en;
  const title = typeof configured === "string" && configured.trim() ? configured.trim() : ts("name");
  const items = editions.flatMap((ed) => {
    const edition = `${slotNames[ed.slot as Slot][locale]} · ${ed.date}`;
    const groupOf = new Map(ed.groups.map((g, i) => [g.groupId, { i, name: locale === "ur" ? g.group.nameUr : g.group.nameEn }]));
    const stories = [...ed.stories].sort((a, b) => (groupOf.get(a.groupId)?.i ?? 99) - (groupOf.get(b.groupId)?.i ?? 99) || a.order - b.order);
    return stories.map((s) => {
      const t = picked(s, "title", locale), summary = picked(s, "summary", locale);
      return {
        id: `${site}/${locale}/story/${s.id}`,
        url: `${site}/${locale}/story/${s.id}`,
        title: t.text,
        summary: summary.text,
        lang: summary.lang,
        date: ed.publishedAt ?? ed.updatedAt,
        group: groupOf.get(s.groupId)?.name ?? "",
        edition,
        sources: outletsOf(s).map((o) => ({ name: o.name, url: o.url })),
      };
    });
  });
  const updated = editions.reduce<Date | null>((m, e) => (e.publishedAt && (!m || e.publishedAt > m) ? e.publishedAt : m), null) ?? new Date();
  return { locale, site, title, items, updated };
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] as string));

export function toRss(f: Awaited<ReturnType<typeof buildFeed>>) {
  const items = f.items.map((i) => `    <item>
      <title>${esc(i.title)}</title>
      <link>${i.url}</link>
      <guid isPermaLink="true">${i.url}</guid>
      <pubDate>${i.date.toUTCString()}</pubDate>
      ${i.group ? `<category>${esc(i.group)}</category>\n      ` : ""}<category>${esc(i.edition)}</category>
      <description>${esc(i.summary)}${i.sources.length ? esc(` (${i.sources.map((s) => s.name).join(", ")})`) : ""}</description>
    </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(f.title)}</title>
    <link>${f.site}/${f.locale}</link>
    <atom:link href="${f.site}/${f.locale}/feed.xml" rel="self" type="application/rss+xml"/>
    <language>${f.locale === "ur" ? "ur-PK" : "en-PK"}</language>
    <lastBuildDate>${f.updated.toUTCString()}</lastBuildDate>
    <description>${esc(f.title)}</description>
${items}
  </channel>
</rss>
`;
}

export function toJsonFeed(f: Awaited<ReturnType<typeof buildFeed>>) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: f.title,
    home_page_url: `${f.site}/${f.locale}`,
    feed_url: `${f.site}/${f.locale}/feed.json`,
    language: f.locale === "ur" ? "ur-PK" : "en-PK",
    items: f.items.map((i) => ({
      id: i.id, url: i.url, title: i.title, summary: i.summary, date_published: i.date.toISOString(), tags: [i.group, i.edition].filter(Boolean),
      ...(i.lang !== f.locale ? { language: i.lang === "ur" ? "ur-PK" : "en-PK" } : {}),
      _sources: i.sources,
    })),
  };
}
