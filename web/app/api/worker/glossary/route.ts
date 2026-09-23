import { NextResponse } from "next/server";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { glossaryIn } from "@/lib/contracts";
import { db, schema } from "@/db";

export async function POST(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const parsed = await parseBody(req, glossaryIn);
  if ("error" in parsed) return parsed.error;
  let added = 0;
  for (const e of parsed.data.entries) {
    const rows = await db.insert(schema.glossary).values({ termEn: e.term_en.trim(), termUr: e.term_ur.trim(), kind: e.kind, locked: false }).onConflictDoNothing().returning({ id: schema.glossary.id });
    added += rows.length;
  }
  return NextResponse.json({ added, skipped: parsed.data.entries.length - added }, noStore);
}
