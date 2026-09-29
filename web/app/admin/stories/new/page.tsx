import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin/session";
import { bylineOf, destinations } from "@/lib/admin/manual";
import { TOPICS, TOPIC_LABELS } from "@/lib/taxonomy";
import { slotNames } from "@/lib/urdu";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { ManualStoryForm } from "./manual-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Add a story" };

export default async function NewManualStoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin("/admin/stories/new");
  const [groups, dest, flash] = await Promise.all([
    db.select({ id: schema.groups.id, nameEn: schema.groups.nameEn, nameUr: schema.groups.nameUr }).from(schema.groups).where(eq(schema.groups.active, true)).orderBy(schema.groups.order, schema.groups.id),
    destinations(),
    flashFrom(searchParams),
  ]);
  const label = (d: { date: string; slot: keyof typeof slotNames }) =>
    `${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d.date}T00:00:00Z`))} · ${d.slot} (${slotNames[d.slot].ur})`;
  return (
    <AdminShell title="Add a story by hand" flash={flash} actions={<Link href="/admin/stories" className="chip">All manual stories</Link>}>
      <p className="meta mb-4 max-w-3xl">
        For news the worker has not picked up. The link to the article is required and is checked once from the server. Readers see the story tagged
        as a manual entry with your name, with an editor&apos;s disclosure instead of the AI one; it is never marked as AI-verified.
      </p>
      {groups.length === 0 ? (
        <p className="card p-6 text-center text-ink-2">No active sections. Switch one on under <Link href="/admin/groups">Groups</Link> first.</p>
      ) : (
        <ManualStoryForm
          byline={bylineOf(user)}
          hasName={!!user.name.trim()}
          groups={groups}
          topics={TOPICS.map((t) => ({ value: t, en: TOPIC_LABELS[t].en, ur: TOPIC_LABELS[t].ur }))}
          upcoming={dest.upcoming ? { id: dest.upcoming.id, label: label(dest.upcoming), stories: dest.upcoming.stories } : null}
          held={dest.held.map((h) => ({ id: h.id!, label: label(h), stories: h.stories }))}
          destinationError={dest.error ?? null}
        />
      )}
    </AdminShell>
  );
}
