import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { runFinish } from "@/lib/contracts";
import { db, schema } from "@/db";
import { missingSourceIds, unknownSources } from "../../_shared";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const parsed = await parseBody(req, runFinish);
  if ("error" in parsed) return parsed.error;
  const d = parsed.data;
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    // Lock the run so a retried PATCH (the client retries on timeouts) waits for this one, then sees
    // finished_at and does nothing: run_sources are recorded and fail streaks counted exactly once.
    const [run] = await tx.select({ finishedAt: schema.runs.finishedAt }).from(schema.runs).where(eq(schema.runs.id, id)).for("update");
    if (!run) return { kind: "not found" as const };
    if (run.finishedAt) return { kind: "already" as const };
    const missing = await missingSourceIds(tx, d.sources.map((s) => s.source_id));
    if (missing.length) return { kind: "unknown sources" as const, missing };
    await tx.update(schema.runs).set({
      status: d.status, finishedAt: now, model: d.model ?? null, tokensIn: d.tokens_in, tokensOut: d.tokens_out,
      costUsd: d.cost_usd.toFixed(4), log: d.log, error: d.error ?? null,
    }).where(eq(schema.runs.id, id));
    if (d.sources.length) {
      await tx.insert(schema.runSources).values(d.sources.map((s) => ({ runId: id, sourceId: s.source_id, ok: s.ok, items: s.items, error: s.error ?? null, ms: s.ms, tier: s.tier, route: s.route })));
      for (const s of d.sources) {
        await tx.update(schema.sources).set(s.ok
          ? { lastOkAt: now, failStreak: 0 }
          : { failStreak: sql`${schema.sources.failStreak} + 1` }).where(eq(schema.sources.id, s.source_id));
      }
    }
    return { kind: "finished" as const };
  });
  if (result.kind === "not found") return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (result.kind === "unknown sources") return unknownSources(result.missing);
  return NextResponse.json(result.kind === "already" ? { ok: true, already: true } : { ok: true }, noStore);
}
