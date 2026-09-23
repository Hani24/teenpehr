import { NextResponse } from "next/server";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { runStart } from "@/lib/contracts";
import { db, schema } from "@/db";

export async function POST(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const parsed = await parseBody(req, runStart);
  if ("error" in parsed) return parsed.error;
  const { kind, date, slot } = parsed.data;
  const [row] = await db.insert(schema.runs).values({ kind, date: date ?? null, slot: slot ?? null }).returning({ id: schema.runs.id });
  return NextResponse.json({ id: row.id }, { status: 201, ...noStore });
}
