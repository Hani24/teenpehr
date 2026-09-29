"use server";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { and, asc, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { httpUrl } from "@/lib/contracts";
import { PUBLISH_POLICIES, SOURCE_KINDS } from "@/lib/codes";
import { normalizeUrdu } from "@/lib/urdu";
import { HIDE_IN_MODES } from "@/lib/view";
import { PALETTES, READING_MODES } from "@/lib/auth/prefs";
import { EDITIONS_TAG, SETTINGS_TAG } from "@/lib/queries";
import { requireAdmin } from "./session";
import { all, bool, list, num, parseOrRedirect, pgError, SHIPPED_TIMES, str, ur, withFlash, type ActionState } from "./util";
import { sourceUsage } from "./data";
import { publishEditionById } from "./publish";
import { writeAudit } from "./manual";
import { FetchTimeoutError, looksPublicHost, NotPublicError, publicGet } from "./public-fetch";

const { sources, groups, topics, handles, glossary, editions, editionGroups, stories, corrections, settings, items, runSources } = schema;
/** What readers see changed: the rendered pages and the cached edition data and settings (lib/queries.ts). */
const site = () => { revalidatePath("/", "layout"); updateTag(EDITIONS_TAG); updateTag(SETTINGS_TAG); };
/** A same-site admin page from a form's `back` field, or null (then the caller's own page). */
function adminBack(b: string): string | null {
  return /^\/admin(?:\/[A-Za-z0-9/_\-.#?=&%]*)?$/.test(b) && !b.includes("//") ? b : null;
}
/** Palette and mode ids come from lib/auth/prefs.ts and lib/view.ts, so adding a palette needs no edit here. */
const paletteId = z.enum(PALETTES), modeId = z.enum(READING_MODES), hideInMode = z.enum(HIDE_IN_MODES);

// ---- sources -----------------------------------------------------------------------------
const sourceSchema = z.object({
  name: z.string().min(1).max(120),
  group_id: z.coerce.number().int().positive(),
  kind: z.enum(SOURCE_KINDS),
  // The worker fetches it: never a loopback, private or link-local address (it checks resolved addresses too).
  url: httpUrl.refine((s) => { try { return looksPublicHost(new URL(s).hostname); } catch { return true; /* httpUrl reports it */ } }, "must be a public internet address"),
  lang: z.string().min(2).max(8),
  perspective: z.string().max(200),
  route: z.enum(["direct", "germany"]),
  max_items: z.coerce.number().int().min(1).max(100),
  fetcher_tier: z.coerce.number().int().min(0).max(3),
  active: z.boolean(),
  notes: z.string().max(2000),
});
export async function saveSource(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id");
  const back = id ? `/admin/sources/${id}` : "/admin/sources/new";
  const d = await parseOrRedirect(sourceSchema, {
    name: str(fd, "name"), group_id: str(fd, "group_id"), kind: str(fd, "kind"), url: str(fd, "url"), lang: str(fd, "lang"),
    perspective: str(fd, "perspective"), route: str(fd, "route"), max_items: str(fd, "max_items") || "8", fetcher_tier: str(fd, "fetcher_tier") || "0",
    active: bool(fd, "active"), notes: str(fd, "notes"),
  }, back);
  const row = { groupId: d.group_id, name: d.name, kind: d.kind, url: d.url, lang: d.lang, perspective: d.perspective, route: d.route, maxItems: d.max_items, fetcherTier: d.fetcher_tier, active: d.active, notes: d.notes };
  let target = id, error = "";
  try {
    // An archived source stays inactive until it is restored.
    if (id) await db.update(sources).set({ ...row, active: sql`(${d.active}::boolean and ${sources.archivedAt} is null)` }).where(eq(sources.id, id));
    else { const [r] = await db.insert(sources).values(row).returning({ id: sources.id }); target = r.id; }
  } catch (e) {
    const { code } = pgError(e);
    if (code === "23505") error = "That group already has a source with this URL (it may be archived: restore it instead).";
    else if (code === "23503") error = "That group no longer exists.";
    else throw e;
  }
  if (error) redirect(await withFlash(back, { error }));
  revalidatePath("/admin/sources"); site();
  redirect(await withFlash(`/admin/sources/${target}`, { ok: "Saved." }));
}
export async function toggleSource(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  await db.update(sources).set({ active: sql`not ${sources.active}` }).where(and(eq(sources.id, id), isNull(sources.archivedAt)));
  revalidatePath("/admin/sources"); revalidatePath(`/admin/sources/${id}`); site();
}
/** Archive instead of delete: the worker stops fetching it, but its items stay cited by published editions. */
export async function archiveSource(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const [r] = await db.update(sources).set({ archivedAt: new Date(), active: false }).where(and(eq(sources.id, id), isNull(sources.archivedAt))).returning({ name: sources.name });
  revalidatePath("/admin/sources"); revalidatePath(`/admin/sources/${id}`); site();
  redirect(await withFlash("/admin/sources", r ? { ok: `Archived ${r.name}. Its items and citations stay; restore it from the archived list.` } : { error: "Source not found or already archived." }));
}
export async function restoreSource(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const [r] = await db.update(sources).set({ archivedAt: null }).where(and(eq(sources.id, id), isNotNull(sources.archivedAt))).returning({ id: sources.id });
  revalidatePath("/admin/sources"); revalidatePath(`/admin/sources/${id}`); site();
  if (!r) redirect(await withFlash("/admin/sources", { error: "Source not found or not archived." }));
  redirect(await withFlash(`/admin/sources/${id}`, { ok: "Restored as inactive. Check it, then switch it on." }));
}
/** Hard delete only for a source that was never fetched: items are cited by stories and run_sources is fetch history. */
export async function deleteSource(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const back = `/admin/sources/${id}`;
  const used = await sourceUsage(id);
  if (used.items || used.runs) redirect(await withFlash(back, { error: `Not deleted: it has ${used.items} items and ${used.runs} fetch records. Archive it instead.` }));
  let deleted: Array<{ name: string }>;
  try {
    // Re-checked in the statement itself so a fetch that lands meanwhile cannot be cascaded away.
    deleted = await db.delete(sources).where(and(eq(sources.id, id),
      notExists(db.select({ one: sql`1` }).from(items).where(eq(items.sourceId, id))),
      notExists(db.select({ one: sql`1` }).from(runSources).where(eq(runSources.sourceId, id))),
    )).returning({ name: sources.name });
  } catch (e) {
    if (pgError(e).code !== "23503") throw e;
    deleted = [];
  }
  if (!deleted.length) redirect(await withFlash(back, { error: "Not deleted: the source was fetched meanwhile or no longer exists. Archive it instead." }));
  revalidatePath("/admin/sources"); site();
  redirect(await withFlash("/admin/sources", { ok: `Deleted ${deleted[0].name}.` }));
}
const TEST_FETCH_MAX_BYTES = 2_000_000;
/**
 * What the fetcher would see at a URL. Public internet only: the request runs on the web server, inside
 * the host's network, so loopback, LAN and link-local addresses are refused, whatever a name resolves
 * to and wherever a redirect points (lib/admin/public-fetch.ts). The body is read up to 2 MB.
 */
export async function testFetch(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  const url = str(fd, "url");
  if (!httpUrl.safeParse(url).success) return { error: "Enter an http(s) URL." };
  const t0 = Date.now();
  try {
    const res = await publicGet(url, { timeoutMs: 10_000, maxBytes: TEST_FETCH_MAX_BYTES, headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
    } });
    const body = res.body;
    const looksLikeFeed = /<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(body.slice(0, 4000));
    const items = (body.match(/<item[\s>]/gi) ?? []).length + (body.match(/<entry[\s>]/gi) ?? []).length;
    return { ok: `HTTP ${res.status} in ${Date.now() - t0} ms`, result: {
      status: res.status, contentType: res.contentType, bytes: res.truncated ? `${res.bytes}+ (stopped reading at 2 MB)` : res.bytes,
      ...(res.redirects ? { finalUrl: res.finalUrl } : {}), looksLikeFeed, items, challenge: /just a moment|cf-chl|captcha/i.test(body.slice(0, 5000)),
    } };
  } catch (e) {
    if (e instanceof NotPublicError) return { error: "Fetch refused: that address (or a redirect from it) is not on the public internet." };
    return { error: `Fetch failed: ${e instanceof FetchTimeoutError ? "timeout after 10 s" : (e as Error).message}` };
  }
}

// ---- groups -----------------------------------------------------------------------------
const groupSchema = z.object({
  name_en: z.string().min(1).max(80), name_ur: z.string().min(1).max(80), brief: z.string().max(4000),
  story_count: z.coerce.number().int().min(1).max(30), active: z.boolean(),
  x_list_ids: z.array(z.string().regex(/^\d{5,25}$/, "list ids are numeric")), hidden_in_themes: z.array(hideInMode),
});
export async function updateGroup(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const back = `/admin/groups/${id}`;
  const d = await parseOrRedirect(groupSchema, { name_en: str(fd, "name_en"), name_ur: ur(fd, "name_ur"), brief: str(fd, "brief"), story_count: str(fd, "story_count") || "7", active: bool(fd, "active"), x_list_ids: list(fd, "x_list_ids"), hidden_in_themes: all(fd, "hidden_in_themes") }, back);
  await db.update(groups).set({ nameEn: d.name_en, nameUr: d.name_ur, brief: d.brief, storyCount: d.story_count, active: d.active, xListIds: d.x_list_ids, hiddenInThemes: d.hidden_in_themes }).where(eq(groups.id, id));
  revalidatePath("/admin/groups"); revalidatePath(back); site();
  redirect(await withFlash(back, { ok: "Group saved." }));
}
export async function moveGroup(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); const dir = str(fd, "dir");
  const rows = await db.select({ id: groups.id }).from(groups).orderBy(asc(groups.order), asc(groups.id));
  const i = rows.findIndex((r) => r.id === id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  await db.transaction(async (tx) => { for (const [k, r] of rows.entries()) await tx.update(groups).set({ order: k }).where(eq(groups.id, r.id)); });
  revalidatePath("/admin/groups"); site();
}
export async function saveTopics(fd: FormData): Promise<void> {
  await requireAdmin();
  const groupId = num(fd, "group_id"); if (!groupId) return;
  const b = num(fd, "boost") ?? 1;
  const boost = Number.isInteger(b) ? Math.min(5, Math.max(1, b)) : 1;
  const row = { keywordsEn: list(fd, "keywords_en"), keywordsUr: list(fd, "keywords_ur").map(normalizeUrdu), boost };
  const [existing] = await db.select({ id: topics.id }).from(topics).where(eq(topics.groupId, groupId)).limit(1);
  if (existing) await db.update(topics).set(row).where(eq(topics.id, existing.id));
  else await db.insert(topics).values({ groupId, ...row });
  revalidatePath(`/admin/groups/${groupId}`);
  redirect(await withFlash(`/admin/groups/${groupId}`, { ok: "Topics saved." }));
}

// ---- handles ----------------------------------------------------------------------------
const handleSchema = z.object({
  platform: z.enum(["x", "bluesky", "telegram", "youtube"]), handle: z.string().min(1).max(100), display_name: z.string().max(200),
  role: z.enum(["outlet", "journalist", "official", "analyst"]), group_id: z.coerce.number().int().positive(),
});
export async function addHandle(fd: FormData): Promise<void> {
  await requireAdmin();
  const d = await parseOrRedirect(handleSchema, { platform: str(fd, "platform"), handle: str(fd, "handle").replace(/^@/, ""), display_name: str(fd, "display_name"), role: str(fd, "role"), group_id: str(fd, "group_id") }, "/admin/handles");
  await db.insert(handles).values({ platform: d.platform, handle: d.handle, displayName: d.display_name, role: d.role, groupId: d.group_id, active: true })
    .onConflictDoUpdate({ target: [handles.platform, handles.handle], set: { displayName: d.display_name, role: d.role, groupId: d.group_id, active: true } });
  revalidatePath("/admin/handles"); site();
  redirect(await withFlash("/admin/handles", { ok: `Added @${d.handle}.` }));
}
export async function toggleHandle(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  await db.update(handles).set({ active: sql`not ${handles.active}` }).where(eq(handles.id, id));
  revalidatePath("/admin/handles"); site();
}
export async function deleteHandle(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  await db.delete(handles).where(eq(handles.id, id));
  revalidatePath("/admin/handles"); site();
}

// ---- glossary ---------------------------------------------------------------------------
const glossarySchema = z.object({ term_en: z.string().min(1).max(200), term_ur: z.string().min(1).max(200), kind: z.enum(["person", "place", "org", "other"]) });
export async function saveGlossary(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id");
  const d = await parseOrRedirect(glossarySchema, { term_en: str(fd, "term_en"), term_ur: ur(fd, "term_ur"), kind: str(fd, "kind") || "other" }, "/admin/glossary");
  let duplicate = false;
  try {
    if (id) await db.update(glossary).set({ termEn: d.term_en, termUr: d.term_ur, kind: d.kind }).where(eq(glossary.id, id));
    // Adding a term that Claude proposed earlier is an editor's review of it, so it locks too.
    else await db.insert(glossary).values({ termEn: d.term_en, termUr: d.term_ur, kind: d.kind, locked: true }).onConflictDoUpdate({ target: glossary.termEn, set: { termUr: d.term_ur, kind: d.kind, locked: true } });
  } catch (e) {
    if (pgError(e).code !== "23505") throw e;
    duplicate = true;
  }
  if (duplicate) redirect(await withFlash("/admin/glossary", { error: `"${d.term_en}" is already in the glossary; edit that entry instead.` }));
  revalidatePath("/admin/glossary"); site();
  redirect(await withFlash("/admin/glossary", { ok: `Saved ${d.term_en}.` }));
}
export async function toggleGlossaryLock(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  await db.update(glossary).set({ locked: sql`not ${glossary.locked}` }).where(eq(glossary.id, id));
  revalidatePath("/admin/glossary");
}
export async function deleteGlossary(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  await db.delete(glossary).where(eq(glossary.id, id));
  revalidatePath("/admin/glossary"); site();
}

// ---- editions ---------------------------------------------------------------------------
const storySchema = z.object({
  title_en: z.string().min(1).max(300), title_ur: z.string().max(300), summary_en: z.string().min(1).max(3000), summary_ur: z.string().max(3000),
  why_en: z.string().max(1000), why_ur: z.string().max(1000), contested_en: z.string().max(1000), contested_ur: z.string().max(1000),
  tag: z.enum(["must-read", "worth-knowing", "skim"]), coverage: z.enum(["broad", "partisan", "single-source", ""]), order: z.coerce.number().int().min(0).max(99),
  qa_status: z.enum(["pending", "verified", "flagged"]), qa_note: z.string().max(1000),
});
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Fail = { error: string; to?: string };
/**
 * Lock the edition row for the rest of the transaction. A publish that races this edit then
 * waits for it (and publishes the edited text), or this edit sees the edition already published.
 */
async function lockEditable(tx: Tx, editionId: number): Promise<Fail | null> {
  const [e] = await tx.select({ status: editions.status }).from(editions).where(eq(editions.id, editionId)).for("update");
  if (!e) return { error: "Edition not found.", to: "/admin/editions" };
  if (e.status === "published") return { error: "Published editions are immutable; add a correction instead." };
  return null;
}
async function failTo(back: string, f: Fail | null): Promise<void> {
  if (f) redirect(await withFlash(f.to ?? back, { error: f.error }));
}
export async function updateStory(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "story_id"); const editionId = num(fd, "edition_id");
  if (!id || !editionId) return;
  const back = `/admin/editions/${editionId}`;
  const keys = ["title_en", "title_ur", "summary_en", "summary_ur", "why_en", "why_ur", "contested_en", "contested_ur", "tag", "coverage", "order", "qa_status", "qa_note"] as const;
  const d = await parseOrRedirect(storySchema, Object.fromEntries(keys.map((k) => [k, k.endsWith("_ur") ? ur(fd, k) : str(fd, k)])), back);
  await failTo(back, await db.transaction(async (tx) => {
    const locked = await lockEditable(tx, editionId); if (locked) return locked;
    const [cur] = await tx.select({ origin: stories.origin, deskAt: stories.deskAt }).from(stories)
      .where(and(eq(stories.id, id), eq(stories.editionId, editionId))).for("update");
    if (!cur) return { error: `Story ${id} is not in this edition (a worker rerun may have replaced the draft); reload the page.` };
    // A manual story live on the Editor's desk (D12, lib/desk.ts) is immutable like a published one.
    if (cur.deskAt) return { error: `Story ${id} is live on the Editor's desk and can no longer be edited; add a correction instead.` };
    // An editor's story is edited on its own page, which queues the missing language's fill and keeps
    // qa 'manual' and its placement rules (lib/admin/manual-actions.ts); this form would skip all that.
    if (cur.origin === "manual") return { error: `Story ${id} is a manual entry; edit it at /admin/stories/${id}.` };
    await tx.update(stories).set({ titleEn: d.title_en, titleUr: d.title_ur, summaryEn: d.summary_en, summaryUr: d.summary_ur, whyEn: d.why_en, whyUr: d.why_ur, contestedEn: d.contested_en, contestedUr: d.contested_ur, tag: d.tag, coverage: d.coverage || null, order: d.order,
      qaStatus: d.qa_status, qaNote: d.qa_note })
      .where(eq(stories.id, id));
    return null;
  }));
  revalidatePath(back);
  redirect(await withFlash(`${back}#story-${id}`, { ok: `Story ${id} saved.` }));
}
export async function updateLead(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "edition_group_id"); const editionId = num(fd, "edition_id");
  if (!id || !editionId) return;
  const back = `/admin/editions/${editionId}`;
  await failTo(back, await db.transaction(async (tx) => {
    const locked = await lockEditable(tx, editionId); if (locked) return locked;
    const r = await tx.update(editionGroups).set({ leadEn: str(fd, "lead_en").slice(0, 400), leadUr: ur(fd, "lead_ur").slice(0, 400) })
      .where(and(eq(editionGroups.id, id), eq(editionGroups.editionId, editionId))).returning({ id: editionGroups.id });
    return r.length ? null : { error: "That group is not part of this edition." };
  }));
  revalidatePath(back);
  redirect(await withFlash(back, { ok: "Lead saved." }));
}
export async function publishEdition(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const back = `/admin/editions/${id}`;
  const r = await publishEditionById(id, bool(fd, "force"));
  revalidatePath(back); revalidatePath("/admin/editions"); revalidatePath("/admin");
  if ("error" in r) redirect(await withFlash(back, { error: r.error }));
  redirect(await withFlash(back, r.status === "published"
    ? { ok: "Published. Its stories show readers they are not reviewed yet until an editor marks them reviewed on the Review page." }
    : { error: `${r.flagged} flagged stories; held for review. Fix them or publish with force.` }));
}
/** Draft → review. The status guard is in the UPDATE so it cannot undo a publish that just happened. */
export async function holdEdition(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const back = `/admin/editions/${id}`;
  const [r] = await db.update(editions).set({ status: "review", updatedAt: new Date() }).where(and(eq(editions.id, id), eq(editions.status, "draft"))).returning({ id: editions.id });
  revalidatePath(back); revalidatePath("/admin/editions"); revalidatePath("/admin");
  redirect(await withFlash(back, r ? { ok: "Held for review. The worker will not overwrite it." } : { error: "Only a draft can be held." }));
}
/** Review → draft, so the worker may rerun the slot (a rerun replaces the stories, including edits made here). */
export async function releaseEdition(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const back = `/admin/editions/${id}`;
  const [r] = await db.update(editions).set({ status: "draft", updatedAt: new Date() }).where(and(eq(editions.id, id), eq(editions.status, "review"))).returning({ id: editions.id });
  revalidatePath(back); revalidatePath("/admin/editions"); revalidatePath("/admin");
  redirect(await withFlash(back, r ? { ok: "Released to draft. A worker run for this slot may now replace it." } : { error: "Only an edition in review can be released." }));
}
/**
 * Corrections are appended to published stories; drafts are edited directly. `back` (optional): the admin page
 * to return to, e.g. the Review page (D14), which uses this same flow.
 */
export async function addCorrection(fd: FormData): Promise<void> {
  const user = await requireAdmin();
  const storyId = num(fd, "story_id"); const editionId = num(fd, "edition_id");
  const textEn = str(fd, "text_en"), textUr = ur(fd, "text_ur");
  if (!storyId || !editionId) return;
  const fromReview = adminBack(str(fd, "back"));
  const back = fromReview ?? `/admin/editions/${editionId}`;
  if (!textEn) redirect(await withFlash(back, { error: "Correction text (English) is required." }));
  await failTo(back, await db.transaction(async (tx): Promise<Fail | null> => {
    const [s] = await tx.select({ status: editions.status, deskAt: stories.deskAt }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId))
      .where(and(eq(stories.id, storyId), eq(stories.editionId, editionId)));
    if (!s) return { error: `Story ${storyId} is not part of this edition.` };
    // Published stories, and manual stories live on the Editor's desk (D12), take corrections; drafts are edited.
    if (s.status !== "published" && !s.deskAt) return { error: "Corrections are for published editions; edit the draft directly." };
    await tx.insert(corrections).values({ storyId, textEn: textEn.slice(0, 2000), textUr: textUr.slice(0, 2000) });
    await writeAudit(tx, user.id, "story.correction", `story:${storyId}`, { edition_id: editionId, text_en: textEn.slice(0, 200) });
    return null;
  }));
  revalidatePath(back); site();
  redirect(await withFlash(`${back}${fromReview ? "" : `#story-${storyId}`}`, { ok: "Correction added." }));
}

// ---- story images (D6) ------------------------------------------------------------------
const hideImageSchema = z.object({
  story_id: z.coerce.number().int().positive().max(2_147_483_647),
  edition_id: z.coerce.number().int().positive().max(2_147_483_647),
});
/**
 * Hide a story's publisher image (editors and owners). On a draft (or an edition held for review) the story
 * simply loses it: stories.image_id is cleared, and a worker rerun of the slot may choose one again. On a
 * published story the text stays exactly as published: the image is hidden from readers from now on, and
 * stories.image_hidden_at/by keep when and who, shown in the story's admin block. Like a correction it is
 * only ever added (editions are immutable), so there is no undo here; it is also written to the server log.
 */
export async function hideStoryImage(fd: FormData): Promise<void> {
  const user = await requireAdmin();
  const d = await parseOrRedirect(hideImageSchema, { story_id: str(fd, "story_id"), edition_id: str(fd, "edition_id") }, "/admin/editions");
  const back = `/admin/editions/${d.edition_id}`;
  const r = await db.transaction(async (tx): Promise<Fail | { published: boolean }> => {
    // The edition row is locked, so a publish racing this either waits for it or is seen here.
    const [e] = await tx.select({ status: editions.status }).from(editions).where(eq(editions.id, d.edition_id)).for("update");
    if (!e) return { error: "Edition not found.", to: "/admin/editions" };
    const inEdition = and(eq(stories.id, d.story_id), eq(stories.editionId, d.edition_id), isNotNull(stories.imageId));
    // A story live on the Editor's desk (D12) is shown to readers like a published one: hide, never remove.
    const [live] = await tx.select({ deskAt: stories.deskAt }).from(stories).where(and(eq(stories.id, d.story_id), eq(stories.editionId, d.edition_id)));
    if (e.status === "published" || live?.deskAt) {
      const rows = await tx.update(stories).set({ imageHiddenAt: new Date(), imageHiddenBy: user.id })
        .where(and(inEdition, isNull(stories.imageHiddenAt))).returning({ id: stories.id });
      return rows.length ? { published: true } : { error: `Story ${d.story_id} has no image to hide in this edition, or it is hidden already.` };
    }
    const rows = await tx.update(stories).set({ imageId: null }).where(inEdition).returning({ id: stories.id });
    return rows.length ? { published: false } : { error: `Story ${d.story_id} has no image in this edition (a worker rerun may have replaced the draft); reload the page.` };
  });
  if ("error" in r) redirect(await withFlash(r.to ?? back, { error: r.error }));
  console.info(`admin: story ${d.story_id} (edition ${d.edition_id}) image ${r.published ? "hidden from readers" : "removed from the draft"} by user ${user.id}`);
  revalidatePath(back);
  if (r.published) site();
  redirect(await withFlash(`${back}#story-${d.story_id}`, {
    ok: r.published ? `Story ${d.story_id}: image hidden from readers. The text is unchanged; who and when are recorded.` : `Story ${d.story_id}: image removed from the draft.`,
  }));
}

// ---- settings ---------------------------------------------------------------------------
const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
const settingsSchema = z.object({
  subh: z.string().regex(timeRe), dopahar: z.string().regex(timeRe), shaam: z.string().regex(timeRe),
  publish_policy: z.enum(PUBLISH_POLICIES), editor_name: z.string().max(100), site_name_en: z.string().min(1).max(60), site_name_ur: z.string().min(1).max(60),
  disclosure_en: z.string().max(600), disclosure_ur: z.string().max(600), digits_ur: z.enum(["latn", "arabext"]), default_theme: paletteId, default_mode: modeId,
  hijri_adjust: z.coerce.number().int().min(-3).max(3), ntfy_note: z.string().max(300),
  translate_daily_limit: z.coerce.number().int().min(0).max(1000),
}).refine((d) => d.subh < d.dopahar && d.dopahar < d.shaam, { path: ["edition_times"], message: "must run subh, then dopahar, then shaam on the same day" });
export async function saveSettings(fd: FormData): Promise<void> {
  await requireAdmin();
  const keys = ["subh", "dopahar", "shaam", "publish_policy", "editor_name", "site_name_en", "site_name_ur", "disclosure_en", "disclosure_ur", "digits_ur", "default_theme", "default_mode", "hijri_adjust", "ntfy_note", "translate_daily_limit"] as const;
  const d = await parseOrRedirect(settingsSchema, Object.fromEntries(keys.map((k) => [k, k.endsWith("_ur") && k !== "digits_ur" ? ur(fd, k) : str(fd, k)])), "/admin/settings");
  const values: Record<string, unknown> = {
    edition_times: { subh: d.subh, dopahar: d.dopahar, shaam: d.shaam }, timezone: "Asia/Karachi", publish_policy: d.publish_policy, editor_name: d.editor_name,
    site_name_en: d.site_name_en, site_name_ur: d.site_name_ur, disclosure_en: d.disclosure_en, disclosure_ur: d.disclosure_ur, digits_ur: d.digits_ur,
    default_theme: d.default_theme, default_mode: d.default_mode, hijri_adjust: d.hijri_adjust, ntfy_note: d.ntfy_note,
    translate_daily_limit: d.translate_daily_limit,
  };
  const timesChanged = await db.transaction(async (tx) => {
    const [prev] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, "edition_times")).for("update");
    for (const [key, value] of Object.entries(values)) await tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    // No row yet means the worker runs on its defaults.
    const p = (prev?.value ?? SHIPPED_TIMES) as Record<string, unknown>;
    return p.subh !== d.subh || p.dopahar !== d.dopahar || p.shaam !== d.shaam;
  });
  revalidatePath("/admin/settings"); site();
  // The worker's timer checks every 10 minutes and reads these times, so a change needs nothing else.
  redirect(await withFlash("/admin/settings", { ok: timesChanged ? "Settings saved. The worker uses the new edition times from its next check (within 10 minutes)." : "Settings saved." }));
}
