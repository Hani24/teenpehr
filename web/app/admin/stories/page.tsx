import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin/session";
import { listManualStories, recentAudit, type ManualState } from "@/lib/admin/manual";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Table, Th, Td, Empty } from "@/components/admin/table";
import { ChipNav, JobPill, StatePill } from "./_ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Manual stories" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const STATES: Array<[ManualState | "", string]> = [["", "All"], ["waiting", "Waiting"], ["desk", "Live on the desk"], ["scheduled", "Scheduled"], ["published", "Published"]];

export default async function ManualStoriesPage({ searchParams }: { searchParams: SP }) {
  const user = await requireAdmin("/admin/stories");
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const mine = one("who") === "mine";
  const state = (STATES.some(([s]) => s === one("state")) ? one("state") : "") as ManualState | "";
  const [all, activity, flash] = await Promise.all([listManualStories({ mine: mine ? user.id : undefined }), recentAudit(["manual_story."], 25), flashFrom(searchParams)]);
  const rows = state ? all.filter((r) => r.state === state) : all;
  const href = (p: { who?: string; state?: string }) => {
    const q = new URLSearchParams();
    const who = p.who ?? (mine ? "mine" : "");
    const st = p.state ?? state;
    if (who) q.set("who", who);
    if (st) q.set("state", st);
    const s = q.toString();
    return `/admin/stories${s ? `?${s}` : ""}`;
  };
  return (
    <AdminShell title="Manual stories" flash={flash} actions={<Link href="/admin/stories/new" className="chip min-h-11 px-4 font-semibold">+ Add a story</Link>}>
      <p className="meta mb-4 max-w-3xl">
        Stories editors added by hand (D12). A story is <em>waiting</em> while a language or a worker job is outstanding; <em>scheduled</em> goes out with its
        edition; <em>live on the desk</em> is on the front page now and joins the next edition that publishes. Live and published stories can only be corrected.
      </p>
      <ChipNav label="Whose" items={[
        { href: href({ who: "" }), label: "Everyone's", current: !mine },
        { href: href({ who: "mine" }), label: "Mine", current: mine },
      ]} />
      <ChipNav label="State" items={STATES.map(([s, label]) => ({ href: href({ state: s }), label, current: state === s, count: s ? all.filter((r) => r.state === s).length : all.length }))} />
      {rows.length === 0 ? (
        <Empty>{all.length === 0 ? <>No manual stories {mine ? "by you " : ""}yet. <Link href="/admin/stories/new">Add one</Link> when the worker has missed something.</> : "None in this state."}</Empty>
      ) : (
        <Table caption="Manual stories">
          <thead><tr><Th>Story</Th><Th>State</Th><Th>Where</Th><Th>Languages</Th><Th>Worker jobs</Th><Th>Added</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="max-w-md">
                  <Link href={`/admin/stories/${r.id}`} className="font-semibold">{r.titleEn || <span lang="ur" dir="rtl">{r.titleUr}</span>}</Link>
                  {r.titleEn && r.titleUr && <span lang="ur" dir="rtl" className="meta block">{r.titleUr}</span>}
                  <span className="meta block">#{r.id} · {r.groupName} · {r.tag}</span>
                </Td>
                <Td><StatePill state={r.state} /></Td>
                <Td className="whitespace-nowrap">
                  <Link href={`/admin/editions/${r.editionId}#story-${r.id}`}>{r.editionDate} {r.editionSlot}</Link>
                  <span className="meta block">{r.placement === "desk" ? "Editor's desk" : "in the edition"}{r.deskAt ? ` · live ${fmtDate(r.deskAt)}` : ""}</span>
                </Td>
                <Td className="whitespace-nowrap">
                  <Lang label="EN" ok={!!(r.titleEn && r.summaryEn)} filled={r.languageFilled === "en"} />{" "}
                  <Lang label="UR" ok={!!(r.titleUr && r.summaryUr)} filled={r.languageFilled === "ur"} />
                </Td>
                <Td>{r.jobs.length ? <span className="flex flex-wrap gap-1">{r.jobs.map((j) => <span key={j.id} title={j.error ?? undefined}>{j.kind === "story_image" ? "image" : `fill ${j.lang}`} <JobPill status={j.status} /></span>)}</span> : <span className="meta">none</span>}</Td>
                <Td className="whitespace-nowrap">{fmtDate(r.createdAt)}<span className="meta block">by {r.createdByName || "—"}</span></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <section aria-labelledby="act" className="mt-8">
        <h2 id="act" className="mb-2 font-semibold">Recent activity</h2>
        {activity.length === 0 ? <Empty>Nothing yet. Adding, editing, publishing on the desk and removing manual stories is recorded here.</Empty> : (
          <ul className="card divide-y divide-rule text-sm">
            {activity.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-3 px-3 py-2">
                <span className="meta whitespace-nowrap">{fmtDate(a.at)}</span>
                <span className="font-semibold">{a.userName || a.userEmail || "a removed account"}</span>
                <span>{ACTIONS[a.action] ?? a.action}</span>
                <TargetLink target={a.target} />
                {typeof a.detail.title === "string" && <span className="meta">“{a.detail.title.slice(0, 80)}”</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AdminShell>
  );
}

const ACTIONS: Record<string, string> = {
  "manual_story.create": "added", "manual_story.edit": "edited", "manual_story.go_live": "put live on the desk", "manual_story.remove": "removed",
};

function TargetLink({ target }: { target: string }) {
  const m = /^story:(\d+)$/.exec(target);
  return m ? <Link href={`/admin/stories/${m[1]}`}>story #{m[1]}</Link> : <span>{target}</span>;
}

function Lang({ label, ok, filled }: { label: string; ok: boolean; filled: boolean }) {
  const title = !ok ? `${label}: not written yet` : filled ? `${label}: written by the worker from the editor's text` : `${label}: written by the editor`;
  return <span className={`pill ${ok ? "pill-soft" : "pill-soft text-warn"}`} title={title}>{label} {ok ? (filled ? "filled" : "✓") : "…"}</span>;
}
