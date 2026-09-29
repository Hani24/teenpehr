import "server-only";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { revalidatePath, revalidateTag } from "next/cache";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { EDITIONS_TAG, getEditionFull, getSettings } from "@/lib/queries";
import { syncEntityStats } from "@/lib/insights";
import { joinDeskStories } from "@/lib/desk";
import { publishPolicyOf, type PublishPolicy } from "@/lib/codes";
import type { Slot } from "@/lib/urdu";

const { editions, stories } = schema;

export type PublishResult =
  | { status: "published"; publishedAt: Date; stories: number; flagged: number; already: boolean }
  | { status: "review"; flagged: number }
  | { error: string; code: 400 | 404 };

/**
 * The one publish path, shared by the worker route and the admin. The edition row is locked FOR UPDATE
 * while the stories are counted and the status changes, and the edition PUT takes the same lock before it
 * replaces stories, so what gets counted is exactly what gets published.
 *
 * `worker: true` (the publish API): an edition in `review` stays there, because only the admin releases a
 * hold, and settings.publish_policy decides a draft (D14, lib/codes.ts PUBLISH_POLICIES): `publish` (the
 * default) publishes it, flagged stories included (each shows readers it is not reviewed yet, with the
 * automatic check's note); `auto` sends it to review when a story is flagged and `force` is false; `hold`
 * always sends it to review. The admin publishes drafts and held editions (a flagged one only with `force`).
 * A published result says how many stories went out and how many of them QA flagged.
 */
export async function publishEdition(id: number, opts: { force: boolean; worker: boolean }): Promise<PublishResult> {
  // The admin's button keeps the `auto` rule: a flagged edition needs its "publish despite flagged" box.
  const policy: PublishPolicy = opts.worker ? publishPolicyOf((await getSettings()).publish_policy) : "auto";
  const now = new Date();
  const r = await db.transaction(async (tx) => {
    const [ed] = await tx.select().from(editions).where(eq(editions.id, id)).for("update");
    if (!ed) return { error: "edition not found", code: 404 as const };
    if (ed.status === "published") {
      const [p] = await tx.select({
        total: count(),
        flagged: sql<number>`count(*) filter (where ${stories.qaStatus} = 'flagged')`.mapWith(Number),
      }).from(stories).where(and(eq(stories.editionId, id), isNull(stories.withdrawnAt)));
      return { status: "published" as const, publishedAt: ed.publishedAt ?? ed.updatedAt, stories: p.total, flagged: p.flagged, already: true as const };
    }
    const [c] = await tx.select({
      total: count(),
      flagged: sql<number>`count(*) filter (where ${stories.qaStatus} = 'flagged')`.mapWith(Number),
    }).from(stories).where(eq(stories.editionId, id));
    if (opts.worker && ed.status === "review") return { status: "review" as const, flagged: c.flagged };
    // Status guards repeat what the lock already guarantees, so a change here can never skip a state.
    const guard = and(eq(editions.id, id), eq(editions.status, ed.status));
    if (policy === "hold" || (policy === "auto" && c.flagged > 0 && !opts.force)) {
      await tx.update(editions).set({ status: "review", updatedAt: now }).where(guard);
      return { status: "review" as const, flagged: c.flagged };
    }
    if (c.total === 0) return { error: "edition has no stories", code: 400 as const };
    // Editor's desk (D12, lib/desk.ts): live desk stories join the edition being published, and manual stories
    // still missing a language move to the upcoming edition instead of going out half-written.
    await joinDeskStories(tx, id);
    // What readers will see: a desk story the editors withdrew (D14) may have joined, and is not counted.
    const [n] = await tx.select({
      total: count(),
      flagged: sql<number>`count(*) filter (where ${stories.qaStatus} = 'flagged')`.mapWith(Number),
    }).from(stories).where(and(eq(stories.editionId, id), isNull(stories.withdrawnAt)));
    if (n.total === 0) throw new NothingLeftToPublish(); // only unready manual stories: roll the moves back
    await tx.update(editions).set({ status: "published", publishedAt: now, updatedAt: now }).where(guard);
    return { status: "published" as const, publishedAt: now, stories: n.total, flagged: n.flagged, already: false as const, date: ed.date, slot: ed.slot as Slot };
  }).catch((e: unknown) => {
    if (e instanceof NothingLeftToPublish) return { error: "edition has no stories ready to publish (its manual stories are not ready yet)", code: 400 as const };
    throw e;
  });
  if (!("error" in r) && r.status === "published" && !r.already) {
    await writeSnapshot(id, r.date, r.slot);
    // Readers see it on their next request: the cached edition data (lib/queries.ts) is expired, not
    // served stale while it refreshes. Called from a route handler (the worker) and a Server Action (the admin).
    revalidateTag(EDITIONS_TAG, { expire: 0 });
    revalidatePath("/", "layout");
    // Entity mention counts count published stories, so they move now, whoever published. A failure
    // here must not turn a publish into an error (the next publish catches up: it is a full recount).
    await syncEntityStats().catch((e) => console.error("entity stats:", (e as Error).message));
    return { status: "published", publishedAt: r.publishedAt, stories: r.stories, flagged: r.flagged, already: false };
  }
  return r;
}

class NothingLeftToPublish extends Error {}

/** Admin wrapper (lib/admin/actions.ts): same effect as the worker's publish route, minus the hold rules. */
export async function publishEditionById(id: number, force: boolean): Promise<{ status: "published" | "review"; flagged: number } | { error: string }> {
  const r = await publishEdition(id, { force, worker: false });
  if ("error" in r) return { error: r.error };
  return r.status === "review" ? r : { status: "published", flagged: r.flagged };
}

let announced = false;
/**
 * Directory for edition snapshots. Never derived from process.cwd(): the standalone server chdirs into
 * .next/standalone, which every `next build` wipes. EDITION_SNAPSHOT_DIR must be absolute.
 */
export function snapshotDir(): string {
  const configured = process.env.EDITION_SNAPSHOT_DIR?.trim();
  const useEnv = !!configured && isAbsolute(configured);
  const dir = useEnv ? configured : join(homedir(), ".local", "share", "teenpehr", "snapshots");
  if (!announced) {
    announced = true;
    if (configured && !useEnv) console.warn(`EDITION_SNAPSHOT_DIR "${configured}" is not an absolute path; ignoring it`);
    console.info(`edition snapshots: ${dir} (${useEnv ? "EDITION_SNAPSHOT_DIR" : "default"})`);
  }
  return dir;
}

/** Durable JSON copy of what was published, so the archive survives any database problem. */
async function writeSnapshot(id: number, date: string, slot: Slot): Promise<void> {
  try {
    // Read from the database, not the reader cache, which may still hold "not published" for this address.
    const full = await getEditionFull(date, slot, true);
    if (!full || full.status !== "published") throw new Error("published edition could not be read back");
    const dir = snapshotDir();
    await mkdir(dir, { recursive: true });
    const snapshotPath = join(dir, `${date}-${slot}.json`);
    const tmp = `${snapshotPath}.${process.pid}.tmp`; // write then rename, so a crash never leaves half a file
    await writeFile(tmp, JSON.stringify(full, null, 2));
    await rename(tmp, snapshotPath);
    await db.update(editions).set({ snapshotPath }).where(eq(editions.id, id));
  } catch (e) {
    console.error(`snapshot of ${date} ${slot} failed:`, (e as Error).message);
  }
}
