import Link from "next/link";
import { getCurrentUser, roleAtLeast } from "@/lib/auth";
import { reviewQueueCounts } from "@/lib/admin/review";
import { Flash } from "./flash";

const nav = [
  ["/admin", "Dashboard"], ["/admin/editions", "Editions"],
  // D14: published stories no editor has reviewed yet (the count is shown beside it).
  ["/admin/review", "Review"],
  // D12 manual stories, D8 reports and feedback, D9 translations, and the worker's job queue.
  ["/admin/stories", "Manual stories"], ["/admin/reports", "Reports"],
  ["/admin/runs", "Runs"], ["/admin/jobs", "Jobs"], ["/admin/translations", "Translations"],
  ["/admin/insights", "Insights"], ["/admin/feedback", "Feedback"], ["/admin/sources", "Sources"],
  ["/admin/groups", "Groups"], ["/admin/handles", "Handles"], ["/admin/glossary", "Glossary"], ["/admin/settings", "Settings"],
] as const;

export async function AdminShell({ title, children, flash, actions }: { title: string; children: React.ReactNode; flash?: { ok?: string; error?: string }; actions?: React.ReactNode }) {
  const user = await getCurrentUser();
  const owner = !!user && roleAtLeast(user.role, "owner");
  const review = user && roleAtLeast(user.role, "editor") ? await reviewQueueCounts() : null;
  return (
    <div className="flex min-h-dvh">
      <a href="#admin-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink">Skip to content</a>
      <aside className="w-52 shrink-0 border-e border-rule bg-surface-2 p-4">
        <p className="masthead-title text-xl"><Link href="/admin" className="no-underline">Tabayyun</Link></p>
        <p className="meta mb-4">admin</p>
        <nav aria-label="Admin">
          <ul className="space-y-1">
            {nav.map(([href, label]) => (
              <li key={href}>
                <Link href={href} className="block rounded px-2 py-1 no-underline hover:bg-surface hover:underline">
                  {label}
                  {href === "/admin/review" && review && review.unreviewed > 0 && (
                    <span className="ms-1 text-sm tabular-nums" title={`${review.unreviewed} published stories not reviewed yet, ${review.flagged} of them flagged by QA`}>
                      <span className="pill pill-soft">{review.unreviewed}</span>
                      {review.flagged > 0 && <span className="pill border border-warn text-warn ms-1">{review.flagged} flagged</span>}
                    </span>
                  )}
                </Link>
              </li>
            ))}
            {owner && <li><Link href="/admin/export" className="block rounded px-2 py-1 no-underline hover:bg-surface hover:underline">Exports</Link></li>}
            {owner && <li><Link href="/admin/users" className="block rounded px-2 py-1 no-underline hover:bg-surface hover:underline">Users</Link></li>}
          </ul>
        </nav>
        <p className="mt-8"><Link href="/en" className="meta" target="_blank" rel="noreferrer">View site ↗</Link></p>
        {user && (
          <div className="mt-4 border-t border-rule pt-3 text-sm">
            <p className="meta">Signed in as</p>
            <p className="truncate font-semibold" title={user.email}><bdi>{user.name || user.email}</bdi></p>
            <p className="meta">{user.role}</p>
            <p className="mt-2"><Link href="/en/account" className="meta">Your account</Link></p>
          </div>
        )}
        <form method="post" action="/api/auth/logout" className="mt-2">
          <input type="hidden" name="locale" value="en" />
          <button type="submit" className="chip cursor-pointer">Log out</button>
        </form>
      </aside>
      <div className="min-w-0 flex-1 p-6">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="headline text-2xl">{title}</h1>
          <div className="ms-auto flex flex-wrap gap-2">{actions}</div>
        </header>
        {flash && <Flash ok={flash.ok} error={flash.error} />}
        <main id="admin-content">{children}</main>
      </div>
    </div>
  );
}
