import "server-only";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { roleAtLeast, type SessionUser } from "@/lib/auth";
import type { XListProposalStatus } from "@/lib/codes";
import { writeAudit } from "./manual";

/*
 * Existing public X Lists proposed for a group (decision D10). The research step (the coverage work) finds
 * lists, verifies each live through the syndication list endpoint, and writes them to
 * web/db/seed/x-list-proposals.json. Nothing here fetches X. The group page shows the proposals; only an
 * owner's "Add to group" puts a list id into groups.x_list_ids (and records the decision in
 * x_list_proposals, status `added`); "Not for this group" records `rejected`. Nothing else writes list ids.
 *
 * The file's format (every field but group and list_id optional; unknown fields ignored):
 *
 *   { "generated_at": "2026-09-29T10:00:00Z",
 *     "proposals": [ { "group": "pakistan", "list_id": "1234567890123456789", "name": "Pakistan journalists",
 *       "owner_handle": "someone", "url": "https://x.com/i/lists/1234567890123456789", "member_count": 48,
 *       "sample_handles": ["handle1", "handle2"], "posts_seen": 100, "newest_post_at": "…", "verified_at": "…",
 *       "note": "why it fits the group, what to watch for" } ] }
 *
 * A bare array of proposals (the shape web/scripts/apply-sources.ts --proposals loads into x_list_proposals), or
 * { "groups": { "<slug>": [ … ] } }, is read too; `group_slug`, `id`, `owner`, `members`, `entries`,
 * `sample_authors` and `notes` are accepted for `group`, `list_id`, `owner_handle`, `member_count`, `posts_seen`,
 * `sample_handles` and `note`, and any field may be null. Entries that do not parse
 * (a list id that is not 5–25 digits, say) are counted and skipped, never guessed at. The file's text is data.
 */

export const PROPOSALS_FILE = "db/seed/x-list-proposals.json";
/** Same rule as the group form's list ids (lib/admin/actions.ts groupSchema). */
const LIST_ID = /^\d{5,25}$/;
const MAX_LISTS_PER_GROUP = 20;

const text = (max: number) => z.string().transform((s) => Array.from(s, (c) => (c.charCodeAt(0) < 32 ? " " : c)).join("").replace(/\s+/g, " ").trim().slice(0, max));
const num = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().nonnegative().max(10_000_000));
const when = z.string().max(40).transform((s) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t) : null; });

// Every field may be missing or null (the research step writes null for what it could not see).
const entrySchema = z.object({
  group: text(60).nullish(), group_slug: text(60).nullish(),
  list_id: z.union([z.string(), z.number()]).nullish(), id: z.union([z.string(), z.number()]).nullish(),
  name: text(200).nullish(), owner_handle: text(60).nullish(), owner: text(60).nullish(),
  url: z.string().max(300).nullish(),
  member_count: num.nullish(), members: num.nullish(),
  sample_handles: z.array(z.string().max(100)).max(200).nullish(), sample_authors: z.array(z.string().max(100)).max(200).nullish(),
  posts_seen: num.nullish(), entries: num.nullish(), newest_post_at: when.nullish(), verified_at: when.nullish(),
  note: text(2000).nullish(), notes: text(2000).nullish(),
});

export type Proposal = {
  groupSlug: string; listId: string; name: string; ownerHandle: string; url: string; memberCount: number | null;
  sampleHandles: string[]; postsSeen: number | null; newestPostAt: Date | null; verifiedAt: Date | null; note: string;
};

/** Only a link to the list itself on X; anything else (another site, a script URL) becomes the canonical address. */
function listUrl(raw: string | null | undefined, listId: string): string {
  try {
    const u = new URL(raw ?? "");
    if (u.protocol === "https:" && /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname) && u.pathname.includes(listId)) return u.toString();
  } catch { /* the canonical address */ }
  return `https://x.com/i/lists/${listId}`;
}

function toProposal(raw: unknown, groupHint?: string): Proposal | null {
  const p = entrySchema.safeParse(raw);
  if (!p.success) return null;
  const e = p.data;
  const listId = String(e.list_id ?? e.id ?? "").trim();
  const groupSlug = (e.group ?? e.group_slug ?? groupHint ?? "").toLowerCase();
  if (!LIST_ID.test(listId) || !/^[a-z0-9-]{1,60}$/.test(groupSlug)) return null;
  const url = listUrl(e.url, listId);
  const handle = (s: string) => s.trim().replace(/^@/, "");
  return {
    groupSlug, listId, url, name: e.name ?? "", ownerHandle: handle(e.owner_handle ?? e.owner ?? "").slice(0, 60),
    memberCount: e.member_count ?? e.members ?? null,
    sampleHandles: [...new Set((e.sample_handles ?? e.sample_authors ?? []).map(handle).filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h)))].slice(0, 12),
    postsSeen: e.posts_seen ?? e.entries ?? null, newestPostAt: e.newest_post_at ?? null, verifiedAt: e.verified_at ?? null, note: (e.note || e.notes) ?? "",
  };
}

/** Where the file may be: X_LIST_PROPOSALS_FILE, the web directory (dev), or two levels up (the standalone server runs in .next/standalone). */
function candidates(): string[] {
  const env = process.env.X_LIST_PROPOSALS_FILE?.trim();
  return [...(env && isAbsolute(env) ? [env] : []), join(process.cwd(), PROPOSALS_FILE), join(process.cwd(), "..", "..", PROPOSALS_FILE)];
}

export type ProposalsFile = { path: string | null; generatedAt: Date | null; modifiedAt: Date | null; proposals: Proposal[]; skipped: number; error?: string };

/** The proposals file, parsed; `path` null when there is none yet. Never throws. */
export async function readProposalsFile(): Promise<ProposalsFile> {
  for (const path of candidates()) {
    let body: string;
    let modifiedAt: Date | null = null;
    try {
      body = await readFile(/*turbopackIgnore: true*/ path, "utf8");
      modifiedAt = (await stat(/*turbopackIgnore: true*/ path)).mtime;
    } catch { continue; }
    let json: unknown;
    try { json = JSON.parse(body); } catch (e) {
      return { path, generatedAt: null, modifiedAt, proposals: [], skipped: 0, error: `not valid JSON: ${(e as Error).message.slice(0, 200)}` };
    }
    const raw: Array<{ entry: unknown; group?: string }> = [];
    const obj = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : null;
    if (Array.isArray(json)) raw.push(...json.map((entry) => ({ entry })));
    else if (obj && Array.isArray(obj.proposals)) raw.push(...obj.proposals.map((entry) => ({ entry })));
    else if (obj) {
      const byGroup = (obj.groups && typeof obj.groups === "object" ? obj.groups : obj) as Record<string, unknown>;
      for (const [group, list] of Object.entries(byGroup)) if (Array.isArray(list)) raw.push(...list.map((entry) => ({ entry, group })));
    }
    const proposals: Proposal[] = [];
    let skipped = 0;
    for (const r of raw.slice(0, 2000)) {
      const p = toProposal(r.entry, r.group);
      if (p) proposals.push(p); else skipped++;
    }
    const gen = obj && typeof obj.generated_at === "string" ? Date.parse(obj.generated_at) : NaN;
    return { path, generatedAt: Number.isFinite(gen) ? new Date(gen) : null, modifiedAt, proposals, skipped };
  }
  return { path: null, generatedAt: null, modifiedAt: null, proposals: [], skipped: 0 };
}

export type GroupProposal = Proposal & {
  status: XListProposalStatus; inGroup: boolean; fromFile: boolean; decidedAt: Date | null; decidedBy: string | null;
};

/** A group's proposals: the file's and the recorded decisions, one row per list id; plus the file's state. */
export async function proposalsForGroup(group: { id: number; slug: string; xListIds: string[] }): Promise<{ file: ProposalsFile; proposals: GroupProposal[] }> {
  const file = await readProposalsFile();
  const rows = await db.select({ p: schema.xListProposals, decider: schema.users.name, deciderEmail: schema.users.email }).from(schema.xListProposals)
    .leftJoin(schema.users, eq(schema.users.id, schema.xListProposals.decidedBy)).where(eq(schema.xListProposals.groupId, group.id));
  const out = new Map<string, GroupProposal>();
  for (const f of file.proposals.filter((p) => p.groupSlug === group.slug)) {
    if (!out.has(f.listId)) out.set(f.listId, { ...f, status: "proposed", inGroup: group.xListIds.includes(f.listId), fromFile: true, decidedAt: null, decidedBy: null });
  }
  for (const { p, decider, deciderEmail } of rows) {
    const prev = out.get(p.listId);
    out.set(p.listId, {
      // Rows can come from scripts/apply-sources.ts (any http(s) URL there): the same rule as the file's.
      groupSlug: group.slug, listId: p.listId, url: listUrl(p.url ?? prev?.url, p.listId),
      name: p.name || prev?.name || "", ownerHandle: p.ownerHandle || prev?.ownerHandle || "", memberCount: p.memberCount ?? prev?.memberCount ?? null,
      sampleHandles: p.sampleHandles.length ? p.sampleHandles : prev?.sampleHandles ?? [], postsSeen: p.postsSeen ?? prev?.postsSeen ?? null,
      newestPostAt: p.newestPostAt ?? prev?.newestPostAt ?? null, verifiedAt: p.verifiedAt ?? prev?.verifiedAt ?? null, note: p.note || prev?.note || "",
      status: p.status, inGroup: group.xListIds.includes(p.listId), fromFile: !!prev, decidedAt: p.decidedAt, decidedBy: decider || deciderEmail || null,
    });
  }
  const rank = { proposed: 0, added: 1, rejected: 2 } as const;
  return { file, proposals: [...out.values()].sort((a, b) => rank[a.status] - rank[b.status] || (b.postsSeen ?? 0) - (a.postsSeen ?? 0)) };
}

export type Decision = "add" | "reject" | "reopen";

/**
 * An owner's decision on a proposed list. `add` appends the id to the group's x_list_ids (once) and records
 * `added`; `reject` records `rejected` (a list already in the group stays until removed in the group form);
 * `reopen` puts a decided proposal back to `proposed`. The proposal must be in the file or already recorded.
 */
export async function decideProposal(user: SessionUser, groupId: number, listId: string, decision: Decision): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  if (!roleAtLeast(user.role, "owner")) return { ok: false, error: "Only an owner decides on X Lists." };
  if (!LIST_ID.test(listId)) return { ok: false, error: "That is not an X List id." };
  const file = await readProposalsFile();
  return db.transaction(async (tx) => {
    const [g] = await tx.select({ id: schema.groups.id, slug: schema.groups.slug, xListIds: schema.groups.xListIds, name: schema.groups.nameEn })
      .from(schema.groups).where(eq(schema.groups.id, groupId)).for("update");
    if (!g) return { ok: false as const, error: "That group no longer exists." };
    const fromFile = file.proposals.find((p) => p.groupSlug === g.slug && p.listId === listId) ?? null;
    const [row] = await tx.select().from(schema.xListProposals).where(and(eq(schema.xListProposals.groupId, g.id), eq(schema.xListProposals.listId, listId)));
    if (!fromFile && !row) return { ok: false as const, error: `List ${listId} is not proposed for ${g.name}.` };
    const now = new Date();
    const status: XListProposalStatus = decision === "add" ? "added" : decision === "reject" ? "rejected" : "proposed";
    let note = "";
    if (decision === "add") {
      if (g.xListIds.includes(listId)) note = `List ${listId} was already in ${g.name}.`;
      else if (g.xListIds.length >= MAX_LISTS_PER_GROUP) return { ok: false as const, error: `${g.name} already has ${g.xListIds.length} lists; remove one in the group form first.` };
      else {
        await tx.update(schema.groups).set({ xListIds: [...g.xListIds, listId] }).where(eq(schema.groups.id, g.id));
        note = `List ${listId} added to ${g.name}. The X collector reads it from its next run.`;
      }
    } else if (decision === "reject") note = g.xListIds.includes(listId) ? `Marked not for ${g.name}. It is still in the group's list ids: remove it in the form above if it should stop.` : `Marked not for ${g.name}.`;
    else note = `List ${listId} is a proposal again.`;
    const details = fromFile ? {
      name: fromFile.name, ownerHandle: fromFile.ownerHandle, url: fromFile.url, memberCount: fromFile.memberCount, sampleHandles: fromFile.sampleHandles,
      postsSeen: fromFile.postsSeen, newestPostAt: fromFile.newestPostAt, verifiedAt: fromFile.verifiedAt, note: fromFile.note,
    } : {};
    const decided = decision === "reopen" ? { decidedBy: null, decidedAt: null } : { decidedBy: user.id, decidedAt: now };
    await tx.insert(schema.xListProposals).values({ groupId: g.id, listId, ...details, status, ...decided })
      .onConflictDoUpdate({ target: [schema.xListProposals.groupId, schema.xListProposals.listId], set: { ...details, status, ...decided } });
    await writeAudit(tx, user.id, `x_list.${decision}`, `group:${g.id}`, { list_id: listId, group: g.slug, in_group: decision === "add" || g.xListIds.includes(listId) });
    return { ok: true as const, note };
  });
}
