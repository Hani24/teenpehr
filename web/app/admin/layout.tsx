import type { Metadata } from "next";
import { inter } from "@/lib/fonts";
import "../globals.css";

export const metadata: Metadata = { title: { default: "Admin · Teen Pehr", template: "%s · Admin" }, robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" className={inter.variable} data-theme="classic">
      <body className="min-h-dvh bg-paper font-sans text-ink text-[15px]">{children}</body>
    </html>
  );
}
