import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { inter, urduFontCss } from "@/lib/fonts";
import { getCurrentUser, loginPath } from "@/lib/auth";
import "../globals.css";

export const metadata: Metadata = { title: { default: "Admin · Tabayyun", template: "%s · Admin" }, robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Behind the proxy's check: signed out, every admin address goes to sign in. Roles are checked by
  // each page and action (requireAdmin/requireOwner), which answer 403 (forbidden.tsx) to readers.
  if (!(await getCurrentUser())) redirect(loginPath("en", "/admin"));
  return (
    <html lang="en" dir="ltr" className={inter.variable} data-theme="classic">
      {/* The web Urdu faces, so Urdu fields and previews look as they will on the site. */}
      <head><style dangerouslySetInnerHTML={{ __html: urduFontCss }} /></head>
      <body className="min-h-dvh bg-paper font-sans text-ink text-[15px]">{children}</body>
    </html>
  );
}
