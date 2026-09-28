import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getEditionFull, getEditionNeighbours } from "./queries";
import type { Slot } from "./urdu";

/** Everything an edition page needs, in one call. */
export async function loadEditionPage(date: string, slot: Slot) {
  const ed = await getEditionFull(date, slot);
  if (!ed) return null;
  const [published, neighbours] = await Promise.all([
    db.select({ slot: schema.editions.slot }).from(schema.editions).where(and(eq(schema.editions.date, date), eq(schema.editions.status, "published"))),
    getEditionNeighbours(date, slot),
  ]);
  return { ed, published: published.map((p) => p.slot as Slot), prev: neighbours.prev, next: neighbours.next };
}
