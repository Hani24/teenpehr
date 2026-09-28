import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["postgres"],
  images: { formats: ["image/avif", "image/webp"] },
  poweredByHeader: false,
  // forbidden() and app/admin/forbidden.tsx: a signed-in reader on an admin page gets a real 403.
  experimental: { authInterrupts: true },
  async headers() {
    return [
      { source: "/fonts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/:path*", headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        // Invite-only (decision D2): no page is for search engines (robots.txt and meta say the same).
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ] },
    ];
  },
};

export default withNextIntl(nextConfig);
