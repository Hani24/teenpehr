import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { postsIn, type PostIn } from "@/lib/contracts";
import { db, schema } from "@/db";

const { posts, handles, storyPosts } = schema;

/**
 * Optional metadata (docs/API.md § POST /api/worker/posts): a field present in the request replaces the
 * stored one, an absent one is left alone. Posts are upserted in batches that share the set of present
 * fields, so each batch's ON CONFLICT names exactly the columns its posts carry.
 */
const META = {
  lang: { key: "lang", column: "lang" },
  metrics: { key: "metrics", column: "metrics" },
  hashtags: { key: "hashtags", column: "hashtags" },
  mentions: { key: "mentions", column: "mentions" },
  urls: { key: "urls", column: "urls" },
  media: { key: "media", column: "media" },
  in_reply_to: { key: "inReplyTo", column: "in_reply_to" },
  conversation_id: { key: "conversationId", column: "conversation_id" },
} as const;
type MetaField = keyof typeof META;
const META_FIELDS = Object.keys(META) as MetaField[];

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
  const batches = new Map<string, PostIn[]>();
  for (const p of values) {
    const sig = META_FIELDS.filter((f) => p[f] !== undefined).join(",");
    batches.set(sig, [...(batches.get(sig) ?? []), p]);
  }
  const now = new Date();
  const out: Array<{ platform_id: string; id: number; is_new: boolean; handle_id: number | null }> = [];
  for (const [sig, batch] of batches) {
    const present = (sig ? sig.split(",") : []) as MetaField[];
    for (let i = 0; i < batch.length; i += 500) {
      const chunk = batch.slice(i, i + 500).map((p) => ({
        handleId: handleId.get(`${p.platform}:${p.author_handle.toLowerCase()}`) ?? null,
        platform: p.platform, platformId: p.platform_id, authorHandle: p.author_handle, authorName: p.author_name, text: p.text, url: p.url,
        postedAt: new Date(p.posted_at), isRepost: p.is_repost, raw: p.raw ?? null, lastSeenAt: now,
        ...Object.fromEntries(present.map((f) => [META[f].key, p[f] ?? null])),
      }));
      // A post a story already cites keeps the text and author name the agent saw, so a re-collection
      // (another route may return longer or edited text) never changes a published edition.
      const cited = sql`exists (select 1 from ${storyPosts} where ${storyPosts.postId} = ${posts.id})`;
      const set: Record<string, SQL> = {
        text: sql`case when ${cited} then ${posts.text} else excluded.text end`,
        authorName: sql`case when ${cited} then ${posts.authorName} else excluded.author_name end`,
        handleId: sql`coalesce(excluded.handle_id, ${posts.handleId})`,
        lastSeenAt: sql`excluded.last_seen_at`,
      };
      for (const f of present) set[META[f].key] = sql.raw(`excluded."${META[f].column}"`);
      const rows = await db.insert(posts).values(chunk).onConflictDoUpdate({ target: [posts.platform, posts.platformId], set })
        .returning({ id: posts.id, platform: posts.platform, platformId: posts.platformId, handleId: posts.handleId });
      rows.forEach((r) => out.push({ platform_id: r.platformId, id: r.id, is_new: !existing.has(`${r.platform}:${r.platformId}`), handle_id: r.handleId }));
    }
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
  const rows = await db.select({ id: posts.id, handle_id: posts.handleId, author_handle: posts.authorHandle, author_name: posts.authorName, text: posts.text, url: posts.url, posted_at: posts.postedAt, is_repost: posts.isRepost, platform: posts.platform,
    // D6: a cited post's first photo can be its story's image, so the worker needs the media it was stored with.
    media: posts.media })
    .from(posts).leftJoin(handles, eq(handles.id, posts.handleId)).where(and(...conds)).orderBy(desc(posts.postedAt)).limit(500);
  return NextResponse.json({ posts: rows }, noStore);
}
