import "server-only";
import { getLatestPublished, getEditionFull, getSettings } from "./queries";
import { isLocale, pick, slotNames, type Locale, type Slot } from "./urdu";
import { outletsOf } from "./view";

export async function buildFeed(localeParam: string) {
  const locale = (isLocale(localeParam) ? localeParam : "en") as Locale;
  const latest = await getLatestPublished();
  const ed = latest ? await getEditionFull(latest.date, latest.slot as Slot) : null;
  const settings = await getSettings();
  const site = process.env.SITE_URL ?? "http://localhost:3000";
  const title = String(locale === "ur" ? settings.site_name_ur ?? "تین پہر" : settings.site_name_en ?? "Teen Pehr");
  const items = (ed?.stories ?? []).map((s) => ({
    id: `${site}/${locale}/story/${s.id}`,
    url: `${site}/${locale}/story/${s.id}`,
    title: pick(s, "title", locale),
    summary: pick(s, "summary", locale),
    date: ed?.publishedAt ?? new Date(),
    group: locale === "ur" ? ed?.groups.find((g) => g.groupId === s.groupId)?.group.nameUr : ed?.groups.find((g) => g.groupId === s.groupId)?.group.nameEn,
    sources: outletsOf(s).map((o) => ({ name: o.name, url: o.url })),
  }));
  const editionTitle = ed ? `${slotNames[ed.slot as Slot][locale]} · ${ed.date}` : "";
  return { locale, site, title, editionTitle, items, updated: ed?.publishedAt ?? new Date() };
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] as string));

export function toRss(f: Awaited<ReturnType<typeof buildFeed>>) {
  const items = f.items.map((i) => `    <item>
      <title>${esc(i.title)}</title>
      <link>${i.url}</link>
      <guid isPermaLink="true">${i.url}</guid>
      <pubDate>${i.date.toUTCString()}</pubDate>
      ${i.group ? `<category>${esc(i.group)}</category>` : ""}
      <description>${esc(i.summary)}${i.sources.length ? esc(` (${i.sources.map((s) => s.name).join(", ")})`) : ""}</description>
    </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(f.title)}${f.editionTitle ? ` — ${esc(f.editionTitle)}` : ""}</title>
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
    items: f.items.map((i) => ({ id: i.id, url: i.url, title: i.title, summary: i.summary, date_published: i.date.toISOString(), tags: i.group ? [i.group] : [], _sources: i.sources })),
  };
}
