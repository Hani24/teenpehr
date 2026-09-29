import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin/session";
import { roleAtLeast } from "@/lib/auth";
import { REPORT_STATUSES, REPORT_TEXT_MAX, type ReportStatus } from "@/lib/codes";
import { listReports, reportCounts } from "@/lib/admin/feedback-insights";
import { decideReportAction } from "@/lib/admin/manual-actions";
import { fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { flashFrom } from "@/components/admin/flash";
import { Empty } from "@/components/admin/table";
import { Button } from "@/components/admin/form";
import { ChipNav, personLabel, Quoted } from "../stories/_ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Mistake reports" };

const LABEL: Record<ReportStatus, string> = { open: "Open", resolved: "Resolved", dismissed: "Dismissed" };

/**
 * "Report a mistake" (D8): readers' free text about a story, for the editors. Resolve (with what was done,
 * usually a correction on the story) or dismiss (with why); either can be reopened. Every decision is logged.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAdmin("/admin/reports");
  const sp = await searchParams;
  const s = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status: ReportStatus = (REPORT_STATUSES as readonly string[]).includes(s ?? "") ? (s as ReportStatus) : "open";
  const [rows, counts, flash] = await Promise.all([listReports(status), reportCounts(), flashFrom(searchParams)]);
  const owner = roleAtLeast(user.role, "owner");
  const back = `/admin/reports?status=${status}`;
  return (
    <AdminShell title="Mistake reports" flash={flash}>
      <p className="meta mb-3 max-w-3xl">
        What readers flagged with &ldquo;Report a mistake&rdquo; / &ldquo;غلطی کی نشاندہی&rdquo;. Their words are shown as written. If the story is wrong, add a correction on
        its edition page (published stories are never edited), then resolve the report saying what you did.
      </p>
      <ChipNav label="Status" items={REPORT_STATUSES.map((st) => ({ href: `/admin/reports?status=${st}`, label: LABEL[st], current: st === status, count: counts[st] }))} />
      {rows.length === 0 ? (
        <Empty>{status === "open" ? "No open reports. Readers' reports land here." : `No ${LABEL[status].toLowerCase()} reports.`}</Empty>
      ) : (
        <ol className="grid gap-4">
          {rows.map((r) => {
            const readerCanSee = r.editionStatus === "published" || !!r.deskAt;
            return (
              <li key={r.id} id={`report-${r.id}`} className="card grid gap-3 p-4">
                <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-semibold">Report #{r.id}</span>
                  <span className="meta">{fmtDate(r.createdAt)} · by <bdi>{personLabel({ id: r.reporterId, name: r.reporter, email: null }, false) ?? "a removed account"}</bdi>{owner && r.reporterEmail ? ` (${r.reporterEmail})` : ""} · read in {r.locale === "ur" ? "Urdu" : "English"}</span>
                  {r.others > 0 && <span className="pill pill-soft">{r.others} other report{r.others === 1 ? "" : "s"} on this story</span>}
                </header>
                <div className="rounded border border-rule bg-surface-2 p-3 text-sm">
                  <p className="meta mb-1">The reader wrote:</p>
                  <Quoted text={r.text} />
                </div>
                <p className="text-sm">
                  On story #{r.storyId}: <strong>{r.titleEn || <span lang="ur" dir="rtl">{r.titleUr}</span>}</strong>
                  {r.titleEn && r.titleUr && <span lang="ur" dir="rtl" className="meta ms-2">{r.titleUr}</span>}
                  <span className="meta block">
                    {r.group} · {r.editionDate} {r.editionSlot} ({r.editionStatus}{r.deskAt ? ", on the desk" : ""}){r.origin === "manual" ? " · manual entry" : ""} ·{" "}
                    <Link href={`/admin/editions/${r.editionId}#story-${r.storyId}`}>edition page (corrections)</Link>
                    {r.origin === "manual" && <> · <Link href={`/admin/stories/${r.storyId}`}>manual story</Link></>}
                    {readerCanSee && <> · <a href={`/${r.locale}/story/${r.storyId}`} target="_blank" rel="noreferrer">as readers see it ↗</a></>}
                  </span>
                </p>
                {r.status !== "open" && (
                  <p className="text-sm"><strong>{LABEL[r.status]}</strong> {fmtDate(r.resolvedAt)} by {r.resolver ?? "—"}{r.note ? <>: <span className="whitespace-pre-wrap">{r.note}</span></> : "."}</p>
                )}
                {r.status === "open" ? (
                  <form action={decideReportAction} className="grid gap-2">
                    <input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={back} />
                    <label className="block text-sm">
                      <span className="mb-1 block font-semibold">Note (what you did, or why not)</span>
                      <textarea name="note" maxLength={REPORT_TEXT_MAX} rows={2} className="w-full rounded border border-rule bg-surface px-2 py-2 text-ink focus:border-focus" dir="auto" />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button tone="primary" name="status" value="resolved" className="min-h-11 px-4">Resolve</Button>
                      <Button name="status" value="dismissed" className="min-h-11 px-4">Dismiss</Button>
                    </div>
                  </form>
                ) : (
                  <form action={decideReportAction}>
                    <input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={back} />
                    <input type="hidden" name="note" value={r.note} />
                    <Button name="status" value="open">Reopen</Button>
                  </form>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </AdminShell>
  );
}
