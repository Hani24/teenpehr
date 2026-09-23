import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getEditionFull } from "@/lib/queries";
import type { Slot } from "@/lib/urdu";

/** Same effect as the worker's publish route: mark published, snapshot to disk, revalidate the site. */
export async function publishEditionById(id: number, force: boolean): Promise<{ status: "published" | "review"; flagged: number } | { error: string }> {
  const ed = await db.query.editions.findFirst({ where: eq(schema.editions.id, id), with: { stories: { columns: { qaStatus: true } } } });
  if (!ed) return { error: "edition not found" };
  if (ed.status === "published") return { status: "published", flagged: 0 };
  if (!ed.stories.length) return { error: "edition has no stories" };
  const flagged = ed.stories.filter((s) => s.qaStatus === "flagged").length;
  if (flagged > 0 && !force) {
    await db.update(schema.editions).set({ status: "review", updatedAt: new Date() }).where(eq(schema.editions.id, id));
    return { status: "review", flagged };
  }
  const now = new Date();
  await db.update(schema.editions).set({ status: "published", publishedAt: now, updatedAt: now }).where(eq(schema.editions.id, id));
  try {
    const full = await getEditionFull(ed.date, ed.slot as Slot);
    const dir = process.env.EDITION_SNAPSHOT_DIR ?? join(process.cwd(), "snapshots");
    await mkdir(dir, { recursive: true });
    const snapshotPath = join(dir, `${ed.date}-${ed.slot}.json`);
    await writeFile(snapshotPath, JSON.stringify(full, null, 2));
    await db.update(schema.editions).set({ snapshotPath }).where(eq(schema.editions.id, id));
  } catch (e) {
    console.warn("snapshot skipped:", (e as Error).message);
  }
  revalidatePath("/", "layout");
  return { status: "published", flagged };
}
