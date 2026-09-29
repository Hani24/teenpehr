/**
 * Apply the verified source list (db/seed/sources.json) to the database: upsert every source by
 * (group, url) and set it active only when its recorded check says it works (decision D11).
 *
 *   npm run sources:apply -- --dry-run      show what would change, change nothing
 *   npm run sources:apply                   apply it
 *   options: --file db/seed/sources.json, --handles (also add new handles from db/seed/handles.json),
 *            --proposals (also load db/seed/x-list-proposals.json into x_list_proposals, as proposals),
 *            --db <name> (another database on the same server as DATABASE_URL, e.g. a throwaway copy
 *            made with `createdb -T teenpehr teenpehr_try`; the credentials stay in .env.local)
 *
 * Each seed row carries `check` from the worker's source audit
 * (`uv run python -m teenpehr.fetch.audit ../web/db/seed/sources.json --write-seed`):
 *   - active = the row's `active` AND check.status === "ok". A row the audit found broken (gone, empty,
 *     stale, a bot wall, needs the Germany route) is set inactive, so runs stop failing on it; its
 *     `notes` say why. A passing failure (timeout, 429, 5xx, the tunnel down) leaves an existing row as it
 *     is and a new row off. Re-run the audit (with --germany) and this script when the Germany route is back.
 *   - `previous_urls` lets a row whose feed moved update the existing row (and keep its items and
 *     history) instead of adding a second one.
 *   - name, kind, lang, perspective, route, max_items and notes follow the seed. fail_streak is reset
 *     when a source is activated or its URL or route changes, since the old failures no longer apply.
 * Archived sources are never touched, sources missing from the seed are left alone (and counted), and
 * `manual` sources (editors' links, D12) are never created here. One transaction: all or nothing.
 * Handles are only ever added (an admin's edits to existing handles stay). X List proposals are
 * written with status "proposed" and never touch groups.x_list_ids or a proposal already decided.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, isNull, sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import { z } from "zod";
import * as schema from "../db/schema";
import { EDITABLE_SOURCE_KINDS } from "../lib/codes";

const CHECK_STATUSES = [
  "ok", "stale", "empty", "needs_germany", "germany_down", "challenge", "gone", "http_error", "parse_error", "timeout",
  "rate_limited", "robots_disallowed", "refused", "unsupported", "unverified",
] as const;

/** An http(s) URL with a host (zod's .url() refuses Urdu paths, so URL does the parsing). */
const httpUrl = z.string().trim().min(8).max(2000).refine((u) => {
  try {
    const p = new URL(u);
    return (p.protocol === "http:" || p.protocol === "https:") && !!p.hostname;
  } catch {
    return false;
  }
}, "not an http(s) URL");
const sourceRow = z.object({
  group: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(EDITABLE_SOURCE_KINDS),
  url: httpUrl,
  lang: z.string().trim().min(2).max(12),
  perspective: z.string().max(300).default(""),
  route: z.enum(["direct", "germany"]).default("direct"),
  max_items: z.number().int().min(1).max(100).default(8),
  active: z.boolean().default(true),
  notes: z.string().max(1000).default(""),
  previous_urls: z.array(httpUrl).max(10).default([]),
  check: z.object({
    status: z.enum(CHECK_STATUSES),
    why: z.string().max(500).optional(),
    checked_at: z.string().max(40).optional(),
    via: z.enum(["direct", "germany"]).optional(), // the route that answered the check (absent: direct)
  }).passthrough().optional(),
}).passthrough();
type SourceRow = z.infer<typeof sourceRow>;

const handleRow = z.object({
  group: z.string().min(1).max(64),
  platform: z.enum(["x", "bluesky", "telegram", "youtube"]),
  handle: z.string().trim().min(1).max(100).transform((h) => h.replace(/^@/, "")),
  display_name: z.string().max(200).default(""),
  role: z.enum(["outlet", "journalist", "official", "analyst"]).default("journalist"),
  active: z.boolean().default(true),
}).passthrough();

const proposalRow = z.object({
  group: z.string().min(1).max(64),
  list_id: z.string().regex(/^[0-9]{1,25}$/),
  name: z.string().max(200).default(""),
  owner: z.string().max(100).default(""),
  url: httpUrl.optional(),
  entries: z.number().int().min(0).nullable().optional(),
  members: z.number().int().min(0).nullable().optional(),
  newest_post_at: z.string().datetime({ offset: true }).nullable().optional(),
  verified_at: z.string().datetime({ offset: true }).nullable().optional(),
  sample_authors: z.array(z.string().max(100)).max(50).default([]),
  notes: z.string().max(2000).default(""),
}).passthrough();

class DryRun extends Error {}

function parseFile<T>(path: string, schemaOf: z.ZodType<T>, what: string): T[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const list = z.array(z.unknown()).parse(raw);
  const out: T[] = [];
  const bad: string[] = [];
  list.forEach((r, i) => {
    const p = schemaOf.safeParse(r);
    if (p.success) out.push(p.data);
    else bad.push(`  ${what} #${i}: ${p.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
  });
  if (bad.length) throw new Error(`${path} has ${bad.length} invalid rows:\n${bad.join("\n")}`);
  return out;
}

/** A check that failed for a passing reason (a timeout, a 429, a 5xx, the Germany tunnel down) says
 *  nothing about the source: an existing row keeps its current state, a new one waits for the next audit. */
const TRANSIENT = new Set<string>(["timeout", "rate_limited", "germany_down"]);
const transient = (c: SourceRow["check"]) =>
  !!c && (TRANSIENT.has(c.status) || (c.status === "http_error" && !/^http 4\d\d/.test(c.why ?? "")));
const wanted = (r: SourceRow, current?: boolean) => r.active && (r.check?.status === "ok" || (transient(r.check) && current === true));

type Counts = { total: number; active: number; byGroup: Record<string, string>; byKind: Record<string, string> };
type Q = Pick<ReturnType<typeof drizzle<typeof schema>>, "select">;

/** Non-archived sources: how many, how many active, and active/total per group and per kind. */
async function countSources(q: Q): Promise<Counts> {
  const rs = await q.select({ slug: schema.groups.slug, kind: schema.sources.kind, active: schema.sources.active, n: dsql<number>`count(*)::int` })
    .from(schema.sources).innerJoin(schema.groups, eq(schema.groups.id, schema.sources.groupId))
    .where(isNull(schema.sources.archivedAt))
    .groupBy(schema.groups.slug, schema.sources.kind, schema.sources.active);
  const sum = (xs: typeof rs) => xs.reduce((a, r) => a + r.n, 0);
  const by = (key: "slug" | "kind") => Object.fromEntries([...new Set(rs.map((r) => r[key]))].sort()
    .map((k) => [k, `${sum(rs.filter((r) => r[key] === k && r.active))}/${sum(rs.filter((r) => r[key] === k))}`]));
  return { total: sum(rs), active: sum(rs.filter((r) => r.active)), byGroup: by("slug"), byKind: by("kind") };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      file: { type: "string", default: join("db", "seed", "sources.json") },
      handles: { type: "boolean", default: false },
      proposals: { type: "boolean", default: false },
      db: { type: "string" },
    },
  });
  const dryRun = values["dry-run"] ?? false;
  const rows = parseFile(values.file ?? "", sourceRow, "source");
  const envUrl = process.env.DATABASE_URL;
  if (!envUrl) throw new Error("DATABASE_URL is not set (npm run sources:apply reads web/.env.local)");
  const target = new URL(envUrl);
  if (values.db !== undefined) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(values.db)) throw new Error("--db takes a plain database name (a-z, 0-9, _)");
    target.pathname = `/${values.db}`;
  }
  console.log(`database: ${target.pathname.slice(1)} on ${target.hostname}:${target.port || "5432"}`);
  const client = postgres(target.toString(), { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });

  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.group} ${r.url}`;
    if (seen.has(k)) throw new Error(`duplicate source in the seed: ${k}`);
    seen.add(k);
  }

  const before = await countSources(db);
  const changes = { inserted: [] as string[], activated: [] as string[], deactivated: [] as string[], moved: [] as string[], rerouted: [] as string[], updated: 0, unchanged: 0, skipped: [] as string[], kept: [] as string[], viaDirect: [] as string[] };
  let after = before;
  let untouched = 0;
  let handlesAdded = 0;
  let proposalsWritten = 0;

  try {
    await db.transaction(async (tx) => {
      const groups = new Map((await tx.select({ id: schema.groups.id, slug: schema.groups.slug }).from(schema.groups)).map((g) => [g.slug, g.id]));
      const existing = await tx.select().from(schema.sources);
      const byKey = new Map(existing.map((s) => [`${s.groupId} ${s.url}`, s]));
      const touched = new Set<number>();

      for (const r of rows) {
        const groupId = groups.get(r.group);
        if (!groupId) { changes.skipped.push(`${r.name}: unknown group ${r.group}`); continue; }
        const found = byKey.get(`${groupId} ${r.url}`) ?? r.previous_urls.map((u) => byKey.get(`${groupId} ${u}`)).find(Boolean);
        const active = wanted(r, found?.active);
        const label = `${r.group}/${r.name}`;
        if (found && touched.has(found.id)) throw new Error(`two seed rows match source #${found.id} (${found.url}); give one of them its own URL`);
        if (found?.archivedAt) { changes.skipped.push(`${label}: archived in the admin, left alone`); touched.add(found.id); continue; }
        if (found && found.kind === "manual") { changes.skipped.push(`${label}: a manual source, left alone`); touched.add(found.id); continue; }
        // Germany is for reach only: a germany row the audit read directly works without the tunnel, and a run
        // would send it through the tunnel anyway (and fail while it is down). Its route belongs on direct.
        if (active && r.route === "germany" && r.check?.status === "ok" && r.check.via !== "germany") changes.viaDirect.push(label);
        if (found && active && r.check?.status !== "ok") changes.kept.push(`${label}: ${r.check?.status}${r.check?.why ? ` (${r.check.why.slice(0, 90)})` : ""}`);
        const fields = { name: r.name, kind: r.kind, url: r.url, lang: r.lang, perspective: r.perspective, route: r.route, maxItems: r.max_items, notes: r.notes, active };
        if (!found) {
          await tx.insert(schema.sources).values({ groupId, ...fields });
          changes.inserted.push(`${label}${active ? " (active)" : ""}`);
          continue;
        }
        touched.add(found.id);
        const moved = found.url !== r.url;
        const rerouted = found.route !== r.route;
        const activating = active && !found.active;
        const same = !moved && !rerouted && found.active === active && found.name === r.name && found.kind === r.kind && found.lang === r.lang
          && found.perspective === r.perspective && found.maxItems === r.max_items && found.notes === r.notes;
        if (same) { changes.unchanged++; continue; }
        await tx.update(schema.sources).set({ ...fields, ...(moved || rerouted || activating ? { failStreak: 0 } : {}) }).where(eq(schema.sources.id, found.id));
        changes.updated++;
        if (activating) changes.activated.push(label);
        if (!active && found.active) changes.deactivated.push(`${label}: ${!r.active ? "off in the seed" : `${r.check?.status ?? "unverified"}${r.check?.why ? ` (${r.check.why.slice(0, 90)})` : ""}`}`);
        if (moved) changes.moved.push(`${label}: ${found.url} -> ${r.url}`);
        if (rerouted) changes.rerouted.push(`${label}: ${found.route} -> ${r.route}`);
      }
      untouched = existing.filter((s) => !touched.has(s.id) && !s.archivedAt && s.kind !== "manual").length;

      if (values.handles) {
        const hs = parseFile(join("db", "seed", "handles.json"), handleRow, "handle");
        for (const h of hs) {
          const groupId = groups.get(h.group);
          if (!groupId) { changes.skipped.push(`handle ${h.handle}: unknown group ${h.group}`); continue; }
          const got = await tx.insert(schema.handles).values({ groupId, platform: h.platform, handle: h.handle, displayName: h.display_name, role: h.role, active: h.active })
            .onConflictDoNothing({ target: [schema.handles.platform, schema.handles.handle] }).returning({ id: schema.handles.id });
          handlesAdded += got.length;
        }
      }

      if (values.proposals) {
        const ps = parseFile(join("db", "seed", "x-list-proposals.json"), proposalRow, "proposal");
        for (const p of ps) {
          const groupId = groups.get(p.group);
          if (!groupId) { changes.skipped.push(`proposal ${p.list_id}: unknown group ${p.group}`); continue; }
          const v = {
            // Always the canonical list address: the file's own `url` is never trusted as a link the admin shows.
            name: p.name, ownerHandle: p.owner, url: `https://x.com/i/lists/${p.list_id}`, memberCount: p.members ?? null,
            sampleHandles: p.sample_authors, postsSeen: p.entries ?? null, newestPostAt: p.newest_post_at ? new Date(p.newest_post_at) : null,
            verifiedAt: p.verified_at ? new Date(p.verified_at) : null, note: p.notes,
          };
          // A proposal an owner already added or rejected keeps its decision; only open ones are refreshed.
          const got = await tx.insert(schema.xListProposals).values({ groupId, listId: p.list_id, ...v })
            .onConflictDoUpdate({ target: [schema.xListProposals.groupId, schema.xListProposals.listId], set: v, setWhere: eq(schema.xListProposals.status, "proposed") })
            .returning({ id: schema.xListProposals.id });
          proposalsWritten += got.length;
        }
      }

      after = await countSources(tx);
      if (dryRun) throw new DryRun();
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }

  const list = (title: string, xs: string[]) => { if (xs.length) console.log(`\n${title} (${xs.length}):\n${xs.map((x) => `  ${x}`).join("\n")}`); };
  console.log(dryRun ? "DRY RUN: nothing was written.\n" : "Applied.\n");
  console.log(`sources before: ${before.active} active of ${before.total}`);
  console.log(`sources after:  ${after.active} active of ${after.total}`);
  console.log(`active by group, before -> after (active/total):`);
  for (const g of Object.keys({ ...before.byGroup, ...after.byGroup }).sort()) console.log(`  ${g.padEnd(14)} ${String(before.byGroup[g] ?? "0/0").padStart(7)} -> ${after.byGroup[g] ?? "0/0"}`);
  console.log(`active by kind, before -> after:`);
  for (const k of Object.keys({ ...before.byKind, ...after.byKind }).sort()) console.log(`  ${k.padEnd(14)} ${String(before.byKind[k] ?? "0/0").padStart(7)} -> ${after.byKind[k] ?? "0/0"}`);
  console.log(`\nrows: ${changes.inserted.length} inserted, ${changes.updated} updated, ${changes.unchanged} unchanged; ${untouched} sources in the database are not in the seed (left alone)`);
  list("inserted", changes.inserted);
  list("activated", changes.activated);
  list("deactivated", changes.deactivated);
  list("kept active despite a passing failure (re-check with the audit's --status)", changes.kept);
  list("route germany but verified directly: set route direct in the seed (runs send it through the tunnel)", changes.viaDirect);
  list("URL changed", changes.moved);
  list("route changed", changes.rerouted);
  list("skipped", changes.skipped);
  if (values.handles) console.log(`\nhandles added: ${handlesAdded}`);
  if (values.proposals) console.log(`\nX List proposals written (open ones only): ${proposalsWritten}`);
  await client.end();
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
