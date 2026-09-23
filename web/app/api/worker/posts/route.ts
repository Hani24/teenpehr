import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { postsIn } from "@/lib/contracts";
import { db, schema } from "@/db";

const { posts, handles } = schema;

export async function POST(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const parsed = await parseBody(req, postsIn);
  if ("error" in parsed) return parsed.error;
  const byId = new Map(parsed.data.posts.map((p) => [`${p.platform}:${p.platform_id}`, p]));
  const values = [...byId.values()];
  if (!values.length) return NextResponse.json({ posts: [] }, noStore);
  const watch = await db.select({ id: handles.id, platform: handles.platform, handle: handles.handle }).from(handles).where(eq(handles.active, true));
  const handleId = new Map(watch.map((h) => [`${h.platform}:${h.handle.toLowerCase()}`, h.id]));
  const ids = values.map((p) => p.platform_id);
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db.select({ p: posts.platform, pid: posts.platformId }).from(posts).where(inArray(posts.platformId, ids.slice(i, i + 500)));
    rows.forEach((r) => existing.add(`${r.p}:${r.pid}`));
  }
  const out: Array<{ platform_id: string; id: number; is_new: boolean; handle_id: number | null }> = [];
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500).map((p) => ({
      handleId: handleId.get(`${p.platform}:${p.author_handle.toLowerCase()}`) ?? null,
      platform: p.platform, platformId: p.platform_id, authorHandle: p.author_handle, authorName: p.author_name, text: p.text, url: p.url,
      postedAt: new Date(p.posted_at), isRepost: p.is_repost, raw: p.raw ?? null,
    }));
    const rows = await db.insert(posts).values(chunk).onConflictDoUpdate({
      target: [posts.platform, posts.platformId],
      set: { text: sql`excluded.text`, authorName: sql`excluded.author_name`, handleId: sql`coalesce(excluded.handle_id, ${posts.handleId})` },
    }).returning({ id: posts.id, platform: posts.platform, platformId: posts.platformId, handleId: posts.handleId });
    rows.forEach((r) => out.push({ platform_id: r.platformId, id: r.id, is_new: !existing.has(`${r.platform}:${r.platformId}`), handle_id: r.handleId }));
  }
  return NextResponse.json({ posts: out }, noStore);
}

export async function GET(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const u = new URL(req.url);
  const since = u.searchParams.get("since")?.replace(" ", "+"); // "+05:00" arrives as a space when unencoded
  const group = u.searchParams.get("group");
  const handle = u.searchParams.get("handle");
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 3600_000);
  if (Number.isNaN(sinceDate.getTime())) return NextResponse.json({ error: "bad since" }, { status: 400 });
  const conds = [gte(posts.postedAt, sinceDate)];
  if (group) {
    const g = await db.query.groups.findFirst({ where: eq(schema.groups.slug, group) });
    if (!g) return NextResponse.json({ error: "unknown group" }, { status: 404 });
    conds.push(eq(handles.groupId, g.id));
  }
  if (handle) conds.push(sql`lower(${posts.authorHandle}) = ${handle.toLowerCase()}`);
  const rows = await db.select({ id: posts.id, handle_id: posts.handleId, author_handle: posts.authorHandle, author_name: posts.authorName, text: posts.text, url: posts.url, posted_at: posts.postedAt, is_repost: posts.isRepost, platform: posts.platform })
    .from(posts).leftJoin(handles, eq(handles.id, posts.handleId)).where(and(...conds)).orderBy(desc(posts.postedAt)).limit(500);
  return NextResponse.json({ posts: rows }, noStore);
}
