import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { runOutputsIn } from "@/lib/contracts";
import { db, schema } from "@/db";

const { runs, runOutputs, groups } = schema;

/**
 * Each Claude call's structured output (docs/API.md § POST /api/worker/runs/{id}/outputs), kept for audits
 * and prompt work; readers never see it. Not deduplicated: the worker sends it only once per call.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const parsed = await parseBody(req, runOutputsIn);
  if ("error" in parsed) return parsed.error;
  const outputs = parsed.data.outputs;
  const slugs = [...new Set(outputs.map((o) => o.group).filter((g): g is string => !!g))];
  const result = await db.transaction(async (tx) => {
    const [run] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, id)).for("key share");
    if (!run) return { kind: "no run" as const };
    const rows = slugs.length ? await tx.select({ id: groups.id, slug: groups.slug }).from(groups).where(inArray(groups.slug, slugs)).for("key share") : [];
    const groupId = new Map(rows.map((g) => [g.slug, g.id]));
    const unknown = slugs.filter((s) => !groupId.has(s));
    if (unknown.length) return { kind: "unknown groups" as const, unknown };
    const inserted = await tx.insert(runOutputs).values(outputs.map((o) => ({
      runId: id, groupId: o.group ? groupId.get(o.group)! : null, stage: o.stage, model: o.model,
      tokensIn: o.tokens_in, tokensOut: o.tokens_out, costUsd: o.cost_usd.toFixed(6), output: o.output as object,
    }))).returning({ id: runOutputs.id });
    return { kind: "ok" as const, ids: inserted.map((r) => r.id) };
  });
  if (result.kind === "no run") return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (result.kind === "unknown groups") return NextResponse.json({ error: "unknown groups", issues: result.unknown }, { status: 400 });
  return NextResponse.json({ ids: result.ids }, { status: 201, ...noStore });
}
