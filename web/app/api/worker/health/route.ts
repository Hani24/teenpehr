import { NextResponse } from "next/server";
import { checkWorkerAuth, noStore } from "@/lib/worker-auth";
import { db, schema } from "@/db";
import { sql } from "drizzle-orm";

export async function GET(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const [{ n, database }] = await db.select({ n: sql<number>`count(*)`, database: sql<string>`current_database()` }).from(schema.groups);
  // `database` lets scripts/smoke.py refuse to write fabricated test editions anywhere but a throwaway database.
  return NextResponse.json({ ok: true, time: new Date().toISOString(), groups: Number(n), database }, noStore);
}
