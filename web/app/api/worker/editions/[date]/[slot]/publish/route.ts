import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { publishIn, isoDate, slot as slotSchema } from "@/lib/contracts";
import { db, schema } from "@/db";
import { getEditionFull, getSettings } from "@/lib/queries";

const { editions } = schema;

export async function POST(req: Request, ctx: { params: Promise<{ date: string; slot: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const p = await ctx.params;
  const date = isoDate.safeParse(p.date), slot = slotSchema.safeParse(p.slot);
  if (!date.success || !slot.success) return NextResponse.json({ error: "bad date or slot" }, { status: 400 });
  const parsed = await parseBody(req, publishIn);
  if ("error" in parsed) return parsed.error;

  const ed = await db.query.editions.findFirst({
    where: and(eq(editions.date, date.data), eq(editions.slot, slot.data)),
    with: { stories: { columns: { qaStatus: true } } },
  });
  if (!ed) return NextResponse.json({ error: "edition not found" }, { status: 404 });
  const url = `/en/${date.data}/${slot.data}`;
  if (ed.status === "published") return NextResponse.json({ status: "published", published_at: ed.publishedAt, url }, noStore);

  const settings = await getSettings();
  const policy = (settings.publish_policy as string | undefined) ?? "auto";
  const flagged = ed.stories.filter((s) => s.qaStatus === "flagged").length;
  if (policy === "hold" || (flagged > 0 && !parsed.data.force)) {
    await db.update(editions).set({ status: "review", updatedAt: new Date() }).where(eq(editions.id, ed.id));
    return NextResponse.json({ status: "review", flagged }, noStore);
  }
  if (ed.stories.length === 0) return NextResponse.json({ error: "edition has no stories" }, { status: 400 });

  const now = new Date();
  await db.update(editions).set({ status: "published", publishedAt: now, updatedAt: now }).where(eq(editions.id, ed.id));

  // Durable snapshot of what was published (survives any database problem).
  let snapshotPath: string | null = null;
  try {
    const full = await getEditionFull(date.data, slot.data);
    const dir = process.env.EDITION_SNAPSHOT_DIR ?? join(process.cwd(), "snapshots");
    await mkdir(dir, { recursive: true });
    snapshotPath = join(dir, `${date.data}-${slot.data}.json`);
    await writeFile(snapshotPath, JSON.stringify(full, null, 2));
    await db.update(editions).set({ snapshotPath }).where(eq(editions.id, ed.id));
  } catch (e) {
    console.warn("snapshot skipped:", (e as Error).message);
  }

  revalidatePath("/", "layout");
  if (parsed.data.notify) void notify(`Edition published: ${date.data} ${slot.data} (${ed.stories.length} stories)`);
  return NextResponse.json({ status: "published", published_at: now.toISOString(), url }, noStore);
}

async function notify(message: string) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${topic}`, { method: "POST", body: message, headers: { Title: "Teen Pehr" } });
  } catch (e) {
    console.warn("ntfy failed:", (e as Error).message);
  }
}
