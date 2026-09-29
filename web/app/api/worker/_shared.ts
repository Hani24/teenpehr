import "server-only";
import { inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { schema, type Tx } from "@/db";

export type { Tx };

/**
 * Source ids from `ids` that have no row in `sources`. Call it inside the transaction that inserts rows
 * referencing them: the found rows are locked FOR KEY SHARE, so an admin delete cannot remove one
 * between this check and the insert (which would otherwise surface as a foreign-key 500).
 */
export async function missingSourceIds(tx: Tx, ids: Iterable<number>): Promise<number[]> {
  const want = [...new Set(ids)];
  if (!want.length) return [];
  const rows = await tx.select({ id: schema.sources.id }).from(schema.sources)
    .where(inArray(schema.sources.id, want)).orderBy(schema.sources.id).for("key share");
  const have = new Set(rows.map((r) => r.id));
  return want.filter((id) => !have.has(id));
}

export function unknownSources(ids: number[]) {
  return NextResponse.json({
    error: `unknown source ids: ${ids.slice(0, 20).join(", ")} (removed in the admin since the run loaded its config?)`,
    issues: { sources: ids.slice(0, 50) },
  }, { status: 400 });
}
