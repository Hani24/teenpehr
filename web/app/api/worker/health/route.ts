import { NextResponse } from "next/server";
import { checkWorkerAuth, noStore } from "@/lib/worker-auth";
import { db, schema } from "@/db";
import { sql } from "drizzle-orm";

export async function GET(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.groups);
  return NextResponse.json({ ok: true, time: new Date().toISOString(), groups: Number(n) }, noStore);
}
