import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { itemsIn, type ItemIn } from "@/lib/contracts";
import { db, schema } from "@/db";
import { missingSourceIds, unknownSources, type Tx } from "../_shared";

const { items, itemSources, itemRevisions, runItems, runs, sources } = schema;

type Stored = { title: string; text: string; published_at: Date | null };
type Existing = { id: number; sourceId: number; urlCanonical: string; title: string; text: string; via: string | undefined };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The feed metadata a new row is stored with (docs/API.md: written once, never rewritten). */
function metadata(it: ItemIn) {
  return {
    author: it.author || null, categories: it.categories ?? [], imageUrl: it.image_url ?? null, description: it.description || null,
    wordCount: it.word_count ?? null, langDetected: it.lang_detected || null, guid: it.guid || null,
    feedUpdatedAt: it.feed_updated_at ? new Date(it.feed_updated_at) : null, siteName: it.site_name || null,
    fetch: it.fetch ?? null, raw: it.raw ?? null,
  };
}

export async function POST(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const parsed = await parseBody(req, itemsIn);
  if ("error" in parsed) return parsed.error;
  const { run_id, items: incoming } = parsed.data;
  if (!incoming.length) return NextResponse.json({ items: [] }, noStore);
  // One row per canonical url, from the first copy in the batch (the worker builds its prompts from that
  // copy too). Every (source, url) pair is a sighting: the same article in two groups' feeds.
  const byCanon = new Map<string, (typeof incoming)[number]>();
  for (const it of incoming) if (!byCanon.has(it.url_canonical)) byCanon.set(it.url_canonical, it);
  const values = [...byCanon.values()];
  const seenBy = new Map<string, Set<number>>();
  // Every copy by (feed, url): a revision compares the item's own feed's copy, not another feed's wording.
  const copies = new Map<string, ItemIn>();
  for (const it of incoming) {
    const feeds = seenBy.get(it.url_canonical) ?? new Set<number>();
    seenBy.set(it.url_canonical, feeds.add(it.source_id));
    if (!copies.has(`${it.source_id} ${it.url_canonical}`)) copies.set(`${it.source_id} ${it.url_canonical}`, it);
  }

  const result = await db.transaction(async (tx) => {
    const missing = await missingSourceIds(tx, incoming.map((it) => it.source_id));
    if (missing.length) return { ok: false as const, missing };
    if (run_id != null) {
      const [run] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, run_id)).for("key share");
      if (!run) return { ok: false as const, noRun: true };
    }
    const out: Array<{ url_canonical: string; id: number; is_new: boolean; stored?: Stored }> = [];
    const existing: Existing[] = [];
    const now = new Date();
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500);
      // An existing item is never rewritten: published stories cite the title and text the agent saw,
      // even if the outlet edits its headline later.
      const inserted = await tx.insert(items).values(chunk.map((it) => ({
        sourceId: it.source_id, runId: run_id ?? null, url: it.url, urlCanonical: it.url_canonical, title: it.title, text: it.text,
        publishedAt: it.published_at ? new Date(it.published_at) : null, lang: it.lang, contentHash: it.content_hash,
        lastSeenAt: now, ...metadata(it),
      }))).onConflictDoNothing({ target: items.urlCanonical }).returning({ id: items.id, urlCanonical: items.urlCanonical });
      inserted.forEach((r) => out.push({ url_canonical: r.urlCanonical, id: r.id, is_new: true }));
      const got = new Set(inserted.map((r) => r.urlCanonical));
      const rest = chunk.map((it) => it.url_canonical).filter((c) => !got.has(c));
      if (rest.length) {
        const rows = await tx.select({ id: items.id, sourceId: items.sourceId, urlCanonical: items.urlCanonical, runId: items.runId, title: items.title, text: items.text, publishedAt: items.publishedAt, fetch: items.fetch })
          .from(items).where(inArray(items.urlCanonical, rest));
        // An item first stored by this same run stays new, so a retried request gives the same answer. The
        // stored fields go back so the worker writes from what the citation will show.
        rows.forEach((r) => {
          out.push({ url_canonical: r.urlCanonical, id: r.id, is_new: run_id != null && r.runId === run_id, stored: { title: r.title, text: r.text, published_at: r.publishedAt } });
          existing.push({ id: r.id, sourceId: r.sourceId, urlCanonical: r.urlCanonical, title: r.title, text: r.text, via: r.fetch?.via });
        });
      }
    }
    const sightings = out.flatMap((o) => [...(seenBy.get(o.url_canonical) ?? [])].map((sourceId) => ({ itemId: o.id, sourceId, firstSeenAt: now, lastSeenAt: now })));
    for (let i = 0; i < sightings.length; i += 1000) {
      await tx.insert(itemSources).values(sightings.slice(i, i + 1000))
        .onConflictDoUpdate({ target: [itemSources.itemId, itemSources.sourceId], set: { lastSeenAt: now } });
    }
    await trackExisting(tx, existing, copies, now);
    if (run_id != null) await recordRunItems(tx, run_id, out, seenBy);
    return { ok: true as const, out };
  });
  if (!result.ok) {
    if ("noRun" in result) return NextResponse.json({ error: "run not found" }, { status: 404 });
    return unknownSources(result.missing);
  }
  return NextResponse.json({ items: result.out }, noStore);
}

/**
 * Research bookkeeping for items that already existed (decision D5): when they were last carried and by
 * how many requests, and a revision row when the outlet's headline or text has changed since the latest
 * known version. The item row itself keeps what was first stored.
 *
 * Only the copy from the item's own feed (the one that first stored it) is compared: another feed's
 * wording of the same article (a Google News title, a section feed) is not the outlet revising it, and
 * comparing whichever copy came first would record the two wordings as revisions back and forth.
 * A text change counts only when the incoming text came the same way as the stored text (`fetch.via`: a
 * feed summary is not compared with an article body fetched another time); a headline-only revision
 * keeps the last comparable text hash, so a later same-way sighting is not taken for a text edit. A copy
 * the worker read back from GET /items for a feed that answered 304 (`fetch.status` 304) is the stored
 * text, not a new sighting of the outlet's, so it never makes a revision.
 */
async function trackExisting(tx: Tx, existing: Existing[], copies: Map<string, ItemIn>, now: Date) {
  if (!existing.length) return;
  const ids = existing.map((e) => e.id);
  for (let i = 0; i < ids.length; i += 1000) {
    await tx.update(items).set({ lastSeenAt: now, seenCount: sql`${items.seenCount} + 1` }).where(inArray(items.id, ids.slice(i, i + 1000)));
  }
  const latest = new Map<number, { title: string; textHash: string }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await tx.selectDistinctOn([itemRevisions.itemId], { itemId: itemRevisions.itemId, title: itemRevisions.title, textHash: itemRevisions.textHash })
      .from(itemRevisions).where(inArray(itemRevisions.itemId, ids.slice(i, i + 1000)))
      .orderBy(itemRevisions.itemId, desc(itemRevisions.seenAt), desc(itemRevisions.id));
    rows.forEach((r) => latest.set(r.itemId, r));
  }
  const revisions: Array<{ itemId: number; title: string; textHash: string; seenAt: Date }> = [];
  for (const e of existing) {
    const it = copies.get(`${e.sourceId} ${e.urlCanonical}`);
    if (!it || it.fetch?.status === 304) continue;
    const known = latest.get(e.id) ?? { title: e.title, textHash: sha256(e.text) };
    const comparable = it.text !== "" && !!e.via && e.via === it.fetch?.via;
    const textHash = comparable ? sha256(it.text) : known.textHash;
    const titleChanged = squash(it.title) !== squash(known.title);
    const textChanged = comparable && textHash !== known.textHash;
    if (titleChanged || textChanged) revisions.push({ itemId: e.id, title: it.title, textHash, seenAt: now });
  }
  for (let i = 0; i < revisions.length; i += 1000) await tx.insert(itemRevisions).values(revisions.slice(i, i + 1000));
}

/** run_items: one row per item and group of each feed that carried it in this run (docs/API.md). */
async function recordRunItems(tx: Tx, runId: number, out: Array<{ url_canonical: string; id: number; is_new: boolean }>, seenBy: Map<string, Set<number>>) {
  const feedIds = [...new Set([...seenBy.values()].flatMap((s) => [...s]))];
  const rows = await tx.select({ id: sources.id, groupId: sources.groupId }).from(sources).where(inArray(sources.id, feedIds));
  const groupOf = new Map(rows.map((r) => [r.id, r.groupId]));
  const seen = new Set<string>();
  const values: Array<{ runId: number; itemId: number; groupId: number; isNew: boolean }> = [];
  for (const o of out) {
    for (const sourceId of seenBy.get(o.url_canonical) ?? []) {
      const groupId = groupOf.get(sourceId);
      const key = `${o.id}:${groupId}`;
      if (groupId === undefined || seen.has(key)) continue;
      seen.add(key);
      values.push({ runId, itemId: o.id, groupId, isNew: o.is_new });
    }
  }
  for (let i = 0; i < values.length; i += 1000) await tx.insert(runItems).values(values.slice(i, i + 1000)).onConflictDoNothing();
}

export async function GET(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const u = new URL(req.url);
  const since = u.searchParams.get("since")?.replace(" ", "+"); // "+05:00" arrives as a space when unencoded
  const group = u.searchParams.get("group");
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 3600_000);
  if (Number.isNaN(sinceDate.getTime())) return NextResponse.json({ error: "bad since" }, { status: 400 });
  // Through the sightings, so a feed gets back every item it carried (source_id is the feed that saw it),
  // including one another group's feed stored first.
  const conds = [gte(itemSources.lastSeenAt, sinceDate)];
  if (group) {
    const g = await db.query.groups.findFirst({ where: eq(schema.groups.slug, group) });
    if (!g) return NextResponse.json({ error: "unknown group" }, { status: 404 });
    conds.push(eq(sources.groupId, g.id));
  }
  const rows = await db.select({
    id: items.id, source_id: itemSources.sourceId, url: items.url, url_canonical: items.urlCanonical, content_hash: items.contentHash,
    title: items.title, text: items.text, published_at: items.publishedAt, lang: items.lang,
    // D6: the stored lead image, so an item read back after a 304 feed answer still has its image candidate.
    image_url: items.imageUrl,
  }).from(itemSources).innerJoin(items, eq(items.id, itemSources.itemId)).innerJoin(sources, eq(sources.id, itemSources.sourceId))
    .where(and(...conds)).orderBy(desc(items.publishedAt)).limit(1000);
  return NextResponse.json({ items: rows }, noStore);
}
