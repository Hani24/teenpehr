import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { itemsIn } from "@/lib/contracts";
import { db, schema } from "@/db";

const { items, sources } = schema;

export async function POST(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const parsed = await parseBody(req, itemsIn);
  if ("error" in parsed) return parsed.error;
  const { run_id, items: incoming } = parsed.data;
  // dedupe within the batch by canonical url (last one wins)
  const byCanon = new Map(incoming.map((i) => [i.url_canonical, i]));
  const canon = [...byCanon.keys()];
  if (!canon.length) return NextResponse.json({ items: [] }, noStore);
  const existing = new Set<string>();
  for (let i = 0; i < canon.length; i += 500) {
    const rows = await db.select({ c: items.urlCanonical }).from(items).where(inArray(items.urlCanonical, canon.slice(i, i + 500)));
    rows.forEach((r) => existing.add(r.c));
  }
  const out: Array<{ url_canonical: string; id: number; is_new: boolean }> = [];
  const values = [...byCanon.values()];
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500).map((it) => ({
      sourceId: it.source_id, runId: run_id ?? null, url: it.url, urlCanonical: it.url_canonical, title: it.title, text: it.text,
      publishedAt: it.published_at ? new Date(it.published_at) : null, lang: it.lang, contentHash: it.content_hash,
    }));
    const rows = await db.insert(items).values(chunk).onConflictDoUpdate({
      target: items.urlCanonical,
      set: { title: sql`excluded.title`, text: sql`case when length(excluded.text) > length(${items.text}) then excluded.text else ${items.text} end`, publishedAt: sql`coalesce(${items.publishedAt}, excluded.published_at)` },
    }).returning({ id: items.id, urlCanonical: items.urlCanonical });
    rows.forEach((r) => out.push({ url_canonical: r.urlCanonical, id: r.id, is_new: !existing.has(r.urlCanonical) }));
  }
  return NextResponse.json({ items: out }, noStore);
}

export async function GET(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const u = new URL(req.url);
  const since = u.searchParams.get("since")?.replace(" ", "+"); // "+05:00" arrives as a space when unencoded
  const group = u.searchParams.get("group");
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 3600_000);
  if (Number.isNaN(sinceDate.getTime())) return NextResponse.json({ error: "bad since" }, { status: 400 });
  const conds = [gte(items.firstSeenAt, sinceDate)];
  if (group) {
    const g = await db.query.groups.findFirst({ where: eq(schema.groups.slug, group) });
    if (!g) return NextResponse.json({ error: "unknown group" }, { status: 404 });
    conds.push(eq(sources.groupId, g.id));
  }
  const rows = await db.select({ id: items.id, source_id: items.sourceId, url: items.url, title: items.title, text: items.text, published_at: items.publishedAt, lang: items.lang })
    .from(items).innerJoin(sources, eq(sources.id, items.sourceId)).where(and(...conds)).orderBy(desc(items.publishedAt)).limit(1000);
  return NextResponse.json({ items: rows }, noStore);
}
