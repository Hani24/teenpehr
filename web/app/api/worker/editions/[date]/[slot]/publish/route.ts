import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { publishIn, isoDate, slot as slotSchema } from "@/lib/contracts";
import { db, schema } from "@/db";
import { publishEdition } from "@/lib/admin/publish";
import { syncEntityStats } from "@/lib/insights";

const { editions } = schema;

export async function POST(req: Request, ctx: { params: Promise<{ date: string; slot: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const p = await ctx.params;
  const date = isoDate.safeParse(p.date), slot = slotSchema.safeParse(p.slot);
  if (!date.success || !slot.success) return NextResponse.json({ error: "bad date or slot" }, { status: 400 });
  const parsed = await parseBody(req, publishIn);
  if ("error" in parsed) return parsed.error;

  const [ed] = await db.select({ id: editions.id }).from(editions).where(and(eq(editions.date, date.data), eq(editions.slot, slot.data)));
  if (!ed) return NextResponse.json({ error: "edition not found" }, { status: 404 });
  const r = await publishEdition(ed.id, { force: parsed.data.force, worker: true });
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.code });
  if (r.status === "review") return NextResponse.json({ status: "review", flagged: r.flagged }, noStore);
  // publishEdition moved the entity mention counts; a repeat publish only makes sure they are current.
  if (r.already) await syncEntityStats().catch((e) => console.error("entity stats:", (e as Error).message));
  // D14: every story goes out marked "not reviewed"; the flagged ones are the editors' first look.
  if (!r.already && parsed.data.notify) {
    const flagged = r.flagged ? `, ${r.flagged} flagged by QA awaiting review` : ", none flagged";
    void notify(`Edition published: ${date.data} ${slot.data} (${r.stories} stories${flagged}; review them in the admin)`);
  }
  return NextResponse.json({ status: "published", published_at: r.publishedAt.toISOString(), url: `/en/${date.data}/${slot.data}`, stories: r.stories, flagged: r.flagged }, noStore);
}

async function notify(message: string) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${topic}`, { method: "POST", body: message, headers: { Title: "Tabayyun" } });
  } catch (e) {
    console.warn("ntfy failed:", (e as Error).message);
  }
}
