import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { editionIn, isoDate, slot as slotSchema } from "@/lib/contracts";
import { db, schema } from "@/db";

const { editions, editionGroups, stories, storySources, storyPosts, threads, groups, items, posts } = schema;

async function existingIds<T extends { id: number }>(table: typeof items | typeof posts, ids: number[]) {
  const found = new Set<number>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await db.select({ id: table.id }).from(table).where(inArray(table.id, ids.slice(i, i + 500)))) as T[];
    rows.forEach((r) => found.add(r.id));
  }
  return found;
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

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    let [ed] = await tx.select().from(editions).where(and(eq(editions.date, date.data), eq(editions.slot, slot.data)));
    if (ed?.status === "published") return { conflict: true as const };
    if (!ed) {
      [ed] = await tx.insert(editions).values({ date: date.data, slot: slot.data, status: data.status, runId: data.run_id ?? null }).returning();
    } else {
      await tx.update(editions).set({ status: data.status, runId: data.run_id ?? ed.runId, updatedAt: now }).where(eq(editions.id, ed.id));
    }
    await tx.delete(stories).where(eq(stories.editionId, ed.id));
    await tx.delete(editionGroups).where(eq(editionGroups.editionId, ed.id));

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
            const [t] = await tx.insert(threads).values({ slug, titleEn: s.thread_title_en ?? s.title_en, titleUr: s.thread_title_ur ?? s.title_ur, lastSeen: now })
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
        }).returning({ id: stories.id });
        const srcByItem = new Map<number, boolean>();
        for (const x of s.sources) srcByItem.set(x.item_id, (srcByItem.get(x.item_id) ?? false) || x.is_primary);
        await tx.insert(storySources).values([...srcByItem].map(([itemId, isPrimary]) => ({ storyId: row.id, itemId, isPrimary })));
        const uniquePosts = [...new Set(s.posts)];
        if (uniquePosts.length) await tx.insert(storyPosts).values(uniquePosts.map((postId) => ({ storyId: row.id, postId })));
        out.push({ order: s.order, group: g.group, id: row.id });
      }
    }
    return { conflict: false as const, editionId: ed.id, status: data.status, stories: out };
  });
  if (result.conflict) return NextResponse.json({ error: "edition already published; append corrections instead" }, { status: 409 });
  return NextResponse.json({ edition_id: result.editionId, status: result.status, stories: result.stories }, noStore);
}
