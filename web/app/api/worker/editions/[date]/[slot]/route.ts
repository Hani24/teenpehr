import { NextResponse } from "next/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { editionIn, isoDate, slot as slotSchema } from "@/lib/contracts";
import { db, schema } from "@/db";
import { entityKey, upsertEntities } from "../../../_entities";
import { ensureEditionGroups } from "@/lib/desk";

const { editions, editionGroups, stories, storySources, storyPosts, storyEntities, threads, groups, items, posts, images } = schema;

/** English words a story shows (title, summary, why, contested) and the time to read them at 220 words a minute. */
function readingStats(s: { title_en: string; summary_en: string; why_en: string; contested_en: string }) {
  const words = `${s.title_en} ${s.summary_en} ${s.why_en} ${s.contested_en}`.split(/\s+/).filter(Boolean).length;
  return { wordCount: words, readingTimeSec: Math.ceil((words * 60) / 220) };
}

async function existingIds<T extends { id: number }>(table: typeof items | typeof posts, ids: number[]) {
  const found = new Set<number>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await db.select({ id: table.id }).from(table).where(inArray(table.id, ids.slice(i, i + 500)))) as T[];
    rows.forEach((r) => found.add(r.id));
  }
  return found;
}

/** Lets the worker skip a slot that is already published or held before it spends anything on it. */
export async function GET(req: Request, ctx: { params: Promise<{ date: string; slot: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const p = await ctx.params;
  const date = isoDate.safeParse(p.date), slot = slotSchema.safeParse(p.slot);
  if (!date.success || !slot.success) return NextResponse.json({ error: "bad date or slot" }, { status: 400 });
  const [ed] = await db.select({ id: editions.id, status: editions.status }).from(editions)
    .where(and(eq(editions.date, date.data), eq(editions.slot, slot.data)));
  if (!ed) return NextResponse.json({ error: "not found" }, { status: 404, ...noStore });
  // Only groups the worker wrote: a row kept for editors' manual stories alone (D12) has no lead and no
  // 'ai' story, and must not make a --groups run think that group is done.
  const written = await db.select({ slug: groups.slug }).from(editionGroups).innerJoin(groups, eq(groups.id, editionGroups.groupId))
    .where(and(eq(editionGroups.editionId, ed.id), sql`(${editionGroups.leadEn} <> '' or exists (select 1 from ${stories} where ${stories.editionId} = ${ed.id} and ${stories.groupId} = ${editionGroups.groupId} and ${stories.origin} = 'ai'))`))
    .orderBy(asc(editionGroups.order));
  return NextResponse.json({ edition_id: ed.id, status: ed.status, groups: written.map((g) => g.slug) }, noStore);
}

export async function PUT(req: Request, ctx: { params: Promise<{ date: string; slot: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const p = await ctx.params;
  const date = isoDate.safeParse(p.date), slot = slotSchema.safeParse(p.slot);
  if (!date.success || !slot.success) return NextResponse.json({ error: "bad date or slot" }, { status: 400 });
  const parsed = await parseBody(req, editionIn);
  if ("error" in parsed) return parsed.error;
  const data = parsed.data;

  const groupRows = await db.select({ id: groups.id, slug: groups.slug }).from(groups);
  const groupId = new Map(groupRows.map((g) => [g.slug, g.id]));
  const unknownGroups = data.groups.map((g) => g.group).filter((s) => !groupId.has(s));
  if (unknownGroups.length) return NextResponse.json({ error: "unknown groups", issues: unknownGroups }, { status: 400 });
  const slugs = data.groups.map((g) => g.group);
  const repeated = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (repeated.length) return NextResponse.json({ error: "a group appears more than once", issues: [...new Set(repeated)] }, { status: 400 });

  const itemIds = new Set<number>(), postIds = new Set<number>();
  for (const g of data.groups) for (const s of g.stories) {
    s.sources.forEach((x) => itemIds.add(x.item_id));
    s.angles.forEach((a) => itemIds.add(a.item_id));
    s.posts.forEach((id) => postIds.add(id));
  }
  const [haveItems, havePosts] = await Promise.all([existingIds(items, [...itemIds]), existingIds(posts, [...postIds])]);
  const missingItems = [...itemIds].filter((id) => !haveItems.has(id));
  const missingPosts = [...postIds].filter((id) => !havePosts.has(id));
  if (missingItems.length || missingPosts.length) {
    return NextResponse.json({ error: "unknown item or post ids", issues: { items: missingItems.slice(0, 50), posts: missingPosts.slice(0, 50) } }, { status: 400 });
  }

  // A story's image (POST /api/worker/images) must exist and belong to an item or post the story cites.
  const imageIds = [...new Set(data.groups.flatMap((g) => g.stories.flatMap((s) => (s.image_id ? [s.image_id] : []))))];
  const imageOwner = new Map<number, { itemId: number | null; postId: number | null }>();
  for (let i = 0; i < imageIds.length; i += 500) {
    const rows = await db.select({ id: images.id, itemId: images.itemId, postId: images.postId }).from(images).where(inArray(images.id, imageIds.slice(i, i + 500)));
    rows.forEach((r) => imageOwner.set(r.id, r));
  }
  const missingImages = imageIds.filter((id) => !imageOwner.has(id));
  if (missingImages.length) return NextResponse.json({ error: "unknown image ids", issues: { images: missingImages.slice(0, 50) } }, { status: 400 });
  const uncited = data.groups.flatMap((g) => g.stories.flatMap((s) => {
    if (!s.image_id) return [];
    const o = imageOwner.get(s.image_id)!;
    const cited = o.itemId != null ? s.sources.some((x) => x.item_id === o.itemId) : s.posts.includes(o.postId!);
    return cited ? [] : [{ group: g.group, order: s.order, image_id: s.image_id }];
  }));
  if (uncited.length) return NextResponse.json({ error: "image not from an item or post its story cites", issues: uncited.slice(0, 50) }, { status: 400 });

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    // Create the row if missing (a concurrent PUT may win; then fall through to it), else lock it. The publish
    // paths take the same row lock, so stories are never swapped under a publish that is counting them.
    let [ed] = await tx.insert(editions).values({ date: date.data, slot: slot.data, status: data.status, runId: data.run_id ?? null })
      .onConflictDoNothing({ target: [editions.date, editions.slot] }).returning();
    if (!ed) {
      [ed] = await tx.select().from(editions).where(and(eq(editions.date, date.data), eq(editions.slot, slot.data))).for("update");
      // Published is immutable; review is an editor's hold that only the admin releases.
      if (ed.status === "published") return { conflict: "edition is published" as const };
      if (ed.status === "review") return { conflict: "edition is in review" as const };
      await tx.update(editions).set({ status: data.status, runId: data.run_id ?? ed.runId, updatedAt: now })
        .where(and(eq(editions.id, ed.id), eq(editions.status, "draft")));
    }
    // Entities first (one upsert for the whole payload); a replaced story's links go with it (cascade).
    const entityId = await upsertEntities(tx, data.groups.flatMap((g) => g.stories.flatMap((s) => s.entities)));
    // partial: replace only the groups in this payload; the draft's other groups and stories stay.
    // An editor's manual stories (D12, lib/desk.ts) are never replaced: only the worker's own ('ai') go.
    const replaced = data.partial ? data.groups.map((g) => groupId.get(g.group)!) : null;
    const own = and(eq(stories.editionId, ed.id), eq(stories.origin, "ai"));
    await tx.delete(stories).where(replaced ? and(own, inArray(stories.groupId, replaced)) : own);
    await tx.delete(editionGroups).where(replaced ? and(eq(editionGroups.editionId, ed.id), inArray(editionGroups.groupId, replaced)) : eq(editionGroups.editionId, ed.id));

    const threadId = new Map<string, number>();
    const out: Array<{ order: number; group: string; id: number }> = [];
    for (const [gi, g] of data.groups.entries()) {
      const gid = groupId.get(g.group)!;
      await tx.insert(editionGroups).values({ editionId: ed.id, groupId: gid, order: gi, leadEn: g.lead_en, leadUr: g.lead_ur, itemCount: g.item_count });
      for (const s of g.stories) {
        let tid: number | null = null;
        if (s.thread) {
          const slug = s.thread.trim().toLowerCase();
          if (!threadId.has(slug)) {
            // No Urdu thread title is stored as "" (a later story fills it), never as this one story's headline.
            const [t] = await tx.insert(threads).values({ slug, titleEn: s.thread_title_en ?? s.title_en, titleUr: s.thread_title_ur ?? "", lastSeen: now })
              .onConflictDoUpdate({ target: threads.slug, set: { lastSeen: now, titleUr: sql`case when excluded.title_ur <> '' and ${threads.titleUr} = '' then excluded.title_ur else ${threads.titleUr} end` } })
              .returning({ id: threads.id });
            threadId.set(slug, t.id);
          }
          tid = threadId.get(slug)!;
        }
        const [row] = await tx.insert(stories).values({
          editionId: ed.id, groupId: gid, threadId: tid, order: s.order,
          titleEn: s.title_en, titleUr: s.title_ur, summaryEn: s.summary_en, summaryUr: s.summary_ur, whyEn: s.why_en, whyUr: s.why_ur,
          tag: s.tag, coverage: s.coverage ?? null, contestedEn: s.contested_en, contestedUr: s.contested_ur,
          angles: s.angles.map((a) => ({ itemId: a.item_id, noteEn: a.note_en, noteUr: a.note_ur })),
          qaStatus: s.qa_status, qaNote: s.qa_note,
          keywords: s.keywords, topics: s.topics, countries: s.countries, places: s.places, eventType: s.event_type ?? null,
          imageId: s.image_id ?? null,
          ...readingStats(s),
        }).returning({ id: stories.id });
        const srcByItem = new Map<number, boolean>();
        for (const x of s.sources) srcByItem.set(x.item_id, (srcByItem.get(x.item_id) ?? false) || x.is_primary);
        await tx.insert(storySources).values([...srcByItem].map(([itemId, isPrimary]) => ({ storyId: row.id, itemId, isPrimary })));
        const uniquePosts = [...new Set(s.posts)];
        if (uniquePosts.length) await tx.insert(storyPosts).values(uniquePosts.map((postId) => ({ storyId: row.id, postId })));
        // Two spellings of one entity in a story are one link, with the higher salience.
        const links = new Map<number, { role: string; salience: number | null }>();
        for (const e of s.entities) {
          const id = entityId.get(entityKey(e))!, prev = links.get(id), salience = e.salience ?? null;
          if (!prev || (salience ?? -1) > (prev.salience ?? -1)) links.set(id, { role: e.role ?? prev?.role ?? "", salience });
        }
        if (links.size) await tx.insert(storyEntities).values([...links].map(([entityId, l]) => ({ storyId: row.id, entityId, role: l.role, salience: l.salience })));
        out.push({ order: s.order, group: g.group, id: row.id });
      }
    }
    // A group that now has only manual stories keeps a row (empty lead); adding one lays the groups out in
    // the configured order, as a partial PUT does.
    const addedForManual = await ensureEditionGroups(tx, ed.id);
    if (replaced && !addedForManual) {
      // Kept and replaced groups interleave, so lay them out in the configured group order.
      const rows = await tx.select({ id: editionGroups.id }).from(editionGroups).innerJoin(groups, eq(groups.id, editionGroups.groupId))
        .where(eq(editionGroups.editionId, ed.id)).orderBy(asc(groups.order), asc(groups.id));
      for (const [i, r] of rows.entries()) await tx.update(editionGroups).set({ order: i }).where(eq(editionGroups.id, r.id));
    }
    return { conflict: null, editionId: ed.id, status: data.status, stories: out };
  });
  if (result.conflict) return NextResponse.json({ error: result.conflict }, { status: 409, ...noStore });
  return NextResponse.json({ edition_id: result.editionId, status: result.status, stories: result.stories }, noStore);
}
