import Link from "next/link";
import { logout } from "@/lib/admin/actions";
import { Flash } from "./flash";

const nav = [
  ["/admin", "Dashboard"], ["/admin/editions", "Editions"], ["/admin/runs", "Runs"], ["/admin/sources", "Sources"],
  ["/admin/groups", "Groups"], ["/admin/handles", "Handles"], ["/admin/glossary", "Glossary"], ["/admin/settings", "Settings"],
] as const;

export function AdminShell({ title, children, flash, actions }: { title: string; children: React.ReactNode; flash?: { ok?: string; error?: string }; actions?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <a href="#admin-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink">Skip to content</a>
      <aside className="w-52 shrink-0 border-r border-rule bg-surface-2 p-4">
        <p className="masthead-title text-xl"><Link href="/admin" className="no-underline">Teen Pehr</Link></p>
        <p className="meta mb-4">admin</p>
        <nav aria-label="Admin">
          <ul className="space-y-1">
            {nav.map(([href, label]) => <li key={href}><Link href={href} className="block rounded px-2 py-1 no-underline hover:bg-surface hover:underline">{label}</Link></li>)}
          </ul>
        </nav>
        <p className="mt-8"><Link href="/en" className="meta" target="_blank" rel="noreferrer">View site ↗</Link></p>
        <form action={logout} className="mt-2"><button type="submit" className="chip">Log out</button></form>
      </aside>
      <div className="min-w-0 flex-1 p-6">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="headline text-2xl">{title}</h1>
          <div className="ml-auto flex flex-wrap gap-2">{actions}</div>
        </header>
        {flash && <Flash ok={flash.ok} error={flash.error} />}
        <main id="admin-content">{children}</main>
      </div>
    </div>
  );
}
