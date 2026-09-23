import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { handleSeenIn } from "@/lib/contracts";
import { db, schema } from "@/db";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const parsed = await parseBody(req, handleSeenIn);
  if ("error" in parsed) return parsed.error;
  const set: Partial<typeof schema.handles.$inferInsert> = {};
  if (parsed.data.last_post_at) set.lastPostAt = new Date(parsed.data.last_post_at);
  if (parsed.data.fallback_used) set.fallbackUsedAt = new Date();
  if (Object.keys(set).length) await db.update(schema.handles).set(set).where(eq(schema.handles.id, id));
  return NextResponse.json({ ok: true }, noStore);
}
