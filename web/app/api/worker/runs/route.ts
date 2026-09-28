import { NextResponse } from "next/server";
import { and, eq, lt } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { runStart } from "@/lib/contracts";
import { db, schema } from "@/db";

/** Longer than any run can live: the systemd units cap an edition run at 100 min and an X collection at 15. */
const ABANDONED_AFTER_MS = 6 * 3600_000;

export async function POST(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const parsed = await parseBody(req, runStart);
  if ("error" in parsed) return parsed.error;
  const { kind, date, slot } = parsed.data;
  const now = new Date();
  // A run whose finishing PATCH never arrived (process killed, laptop slept, or a POST /runs retried after
  // a timeout that had already committed) would stay "running" forever; close those out here.
  await db.update(schema.runs).set({ status: "failed", finishedAt: now, error: "abandoned: the worker never reported a result" })
    .where(and(eq(schema.runs.status, "running"), lt(schema.runs.startedAt, new Date(now.getTime() - ABANDONED_AFTER_MS))));
  const [row] = await db.insert(schema.runs).values({ kind, date: date ?? null, slot: slot ?? null }).returning({ id: schema.runs.id });
  return NextResponse.json({ id: row.id }, { status: 201, ...noStore });
}
