import type { MetadataRoute } from "next";

/** Invite-only (decision D2): nothing on this site is for crawlers. Pages also carry noindex. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
