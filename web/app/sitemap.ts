import type { MetadataRoute } from "next";
import { listPublishedEditions } from "@/lib/queries";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = process.env.SITE_URL ?? "http://localhost:3000";
  const editions = await listPublishedEditions(500);
  const statics: MetadataRoute.Sitemap = ["", "/archive", "/about"].flatMap((p) => ["en", "ur"].map((l) => ({
    url: `${site}/${l}${p}`, changeFrequency: "hourly" as const, priority: p === "" ? 1 : 0.5,
    alternates: { languages: { en: `${site}/en${p}`, ur: `${site}/ur${p}` } },
  })));
  const eds: MetadataRoute.Sitemap = editions.flatMap((e) => ["en", "ur"].map((l) => ({
    url: `${site}/${l}/${e.date}/${e.slot}`, lastModified: e.publishedAt ?? undefined, changeFrequency: "never" as const, priority: 0.8,
    alternates: { languages: { en: `${site}/en/${e.date}/${e.slot}`, ur: `${site}/ur/${e.date}/${e.slot}` } },
  })));
  return [...statics, ...eds];
}
