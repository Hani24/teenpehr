"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { checkPassword, clearSession, requireAdmin, setSession } from "./session";
import { all, bool, list, num, parseOrRedirect, str, withFlash, type ActionState } from "./util";
import { publishEditionById } from "./publish";

const { sources, groups, topics, handles, glossary, editions, editionGroups, stories, corrections, settings } = schema;
const site = () => revalidatePath("/", "layout");

// ---- auth --------------------------------------------------------------------------------
export async function login(_prev: ActionState, fd: FormData): Promise<ActionState> {
  if (!checkPassword(str(fd, "password"))) return { error: "Wrong password." };
  await setSession();
  redirect("/admin");
}
export async function logout(): Promise<void> {
  await clearSession();
  redirect("/admin/login");
}

// ---- sources -----------------------------------------------------------------------------
const sourceSchema = z.object({
  name: z.string().min(1).max(120),
  group_id: z.coerce.number().int().positive(),
  kind: z.enum(["rss", "html", "gnews", "youtube", "telegram"]),
  url: z.url().max(2000),
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
  const d = parseOrRedirect(sourceSchema, {
    name: str(fd, "name"), group_id: str(fd, "group_id"), kind: str(fd, "kind"), url: str(fd, "url"), lang: str(fd, "lang"),
    perspective: str(fd, "perspective"), route: str(fd, "route"), max_items: str(fd, "max_items") || "8", fetcher_tier: str(fd, "fetcher_tier") || "0",
    active: bool(fd, "active"), notes: str(fd, "notes"),
  }, back);
  const row = { groupId: d.group_id, name: d.name, kind: d.kind, url: d.url, lang: d.lang, perspective: d.perspective, route: d.route, maxItems: d.max_items, fetcherTier: d.fetcher_tier, active: d.active, notes: d.notes };
  let target = id;
  if (id) await db.update(sources).set(row).where(eq(sources.id, id));
  else { const [r] = await db.insert(sources).values(row).returning({ id: sources.id }); target = r.id; }
  revalidatePath("/admin/sources"); site();
  redirect(withFlash(`/admin/sources/${target}`, { ok: "Saved." }));
}
export async function toggleSource(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const [s] = await db.select({ active: sources.active }).from(sources).where(eq(sources.id, id));
  if (s) await db.update(sources).set({ active: !s.active }).where(eq(sources.id, id));
  revalidatePath("/admin/sources"); revalidatePath(`/admin/sources/${id}`); site();
}
export async function deleteSource(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  await db.delete(sources).where(eq(sources.id, id));
  revalidatePath("/admin/sources"); site();
  redirect(withFlash("/admin/sources", { ok: "Source deleted." }));
}
export async function testFetch(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  const url = str(fd, "url");
  if (!/^https?:\/\//.test(url)) return { error: "Enter an http(s) URL." };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", cache: "no-store", headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
    } });
    const body = await res.text();
    const looksLikeFeed = /<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(body.slice(0, 4000));
    const items = (body.match(/<item[\s>]/gi) ?? []).length + (body.match(/<entry[\s>]/gi) ?? []).length;
    return { ok: `HTTP ${res.status} in ${Date.now() - t0} ms`, result: { status: res.status, contentType: res.headers.get("content-type") ?? "", bytes: Buffer.byteLength(body), looksLikeFeed, items, challenge: /just a moment|cf-chl|captcha/i.test(body.slice(0, 5000)) } };
  } catch (e) {
    return { error: `Fetch failed: ${(e as Error).name === "AbortError" ? "timeout after 10 s" : (e as Error).message}` };
  } finally { clearTimeout(timer); }
}

// ---- groups -----------------------------------------------------------------------------
const groupSchema = z.object({
  name_en: z.string().min(1).max(80), name_ur: z.string().min(1).max(80), brief: z.string().max(4000),
  story_count: z.coerce.number().int().min(1).max(30), active: z.boolean(),
  x_list_ids: z.array(z.string().regex(/^\d{5,25}$/, "list ids are numeric")), hidden_in_themes: z.array(z.enum(["classic", "night", "buzurg"])),
});
export async function updateGroup(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const back = `/admin/groups/${id}`;
  const d = parseOrRedirect(groupSchema, { name_en: str(fd, "name_en"), name_ur: str(fd, "name_ur"), brief: str(fd, "brief"), story_count: str(fd, "story_count") || "7", active: bool(fd, "active"), x_list_ids: list(fd, "x_list_ids"), hidden_in_themes: all(fd, "hidden_in_themes") }, back);
  await db.update(groups).set({ nameEn: d.name_en, nameUr: d.name_ur, brief: d.brief, storyCount: d.story_count, active: d.active, xListIds: d.x_list_ids, hiddenInThemes: d.hidden_in_themes }).where(eq(groups.id, id));
  revalidatePath("/admin/groups"); revalidatePath(back); site();
  redirect(withFlash(back, { ok: "Group saved." }));
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
  const boost = Math.min(5, Math.max(1, num(fd, "boost") ?? 1));
  const row = { keywordsEn: list(fd, "keywords_en"), keywordsUr: list(fd, "keywords_ur"), boost };
  const [existing] = await db.select({ id: topics.id }).from(topics).where(eq(topics.groupId, groupId)).limit(1);
  if (existing) await db.update(topics).set(row).where(eq(topics.id, existing.id));
  else await db.insert(topics).values({ groupId, ...row });
  revalidatePath(`/admin/groups/${groupId}`);
  redirect(withFlash(`/admin/groups/${groupId}`, { ok: "Topics saved." }));
}

// ---- handles ----------------------------------------------------------------------------
const handleSchema = z.object({
  platform: z.enum(["x", "bluesky", "telegram", "youtube"]), handle: z.string().min(1).max(100), display_name: z.string().max(200),
  role: z.enum(["outlet", "journalist", "official", "analyst"]), group_id: z.coerce.number().int().positive(),
});
export async function addHandle(fd: FormData): Promise<void> {
  await requireAdmin();
  const d = parseOrRedirect(handleSchema, { platform: str(fd, "platform"), handle: str(fd, "handle").replace(/^@/, ""), display_name: str(fd, "display_name"), role: str(fd, "role"), group_id: str(fd, "group_id") }, "/admin/handles");
  await db.insert(handles).values({ platform: d.platform, handle: d.handle, displayName: d.display_name, role: d.role, groupId: d.group_id, active: true })
    .onConflictDoUpdate({ target: [handles.platform, handles.handle], set: { displayName: d.display_name, role: d.role, groupId: d.group_id, active: true } });
  revalidatePath("/admin/handles"); site();
  redirect(withFlash("/admin/handles", { ok: `Added @${d.handle}.` }));
}
export async function toggleHandle(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const [h] = await db.select({ active: handles.active }).from(handles).where(eq(handles.id, id));
  if (h) await db.update(handles).set({ active: !h.active }).where(eq(handles.id, id));
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
  const d = parseOrRedirect(glossarySchema, { term_en: str(fd, "term_en"), term_ur: str(fd, "term_ur"), kind: str(fd, "kind") || "other" }, "/admin/glossary");
  if (id) await db.update(glossary).set({ termEn: d.term_en, termUr: d.term_ur, kind: d.kind }).where(eq(glossary.id, id));
  else await db.insert(glossary).values({ termEn: d.term_en, termUr: d.term_ur, kind: d.kind, locked: true }).onConflictDoUpdate({ target: glossary.termEn, set: { termUr: d.term_ur, kind: d.kind } });
  revalidatePath("/admin/glossary");
  redirect(withFlash("/admin/glossary", { ok: `Saved ${d.term_en}.` }));
}
export async function toggleGlossaryLock(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const [g] = await db.select({ locked: glossary.locked }).from(glossary).where(eq(glossary.id, id));
  if (g) await db.update(glossary).set({ locked: !g.locked }).where(eq(glossary.id, id));
  revalidatePath("/admin/glossary");
}
export async function deleteGlossary(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  await db.delete(glossary).where(eq(glossary.id, id));
  revalidatePath("/admin/glossary");
}

// ---- editions ---------------------------------------------------------------------------
const storySchema = z.object({
  title_en: z.string().min(1).max(300), title_ur: z.string().max(300), summary_en: z.string().min(1).max(3000), summary_ur: z.string().max(3000),
  why_en: z.string().max(1000), why_ur: z.string().max(1000), contested_en: z.string().max(1000), contested_ur: z.string().max(1000),
  tag: z.enum(["must-read", "worth-knowing", "skim"]), coverage: z.enum(["broad", "partisan", "single-source", ""]), order: z.coerce.number().int().min(0).max(99),
  qa_status: z.enum(["pending", "verified", "flagged"]), qa_note: z.string().max(1000),
});
async function editableEdition(editionId: number, back: string) {
  const [e] = await db.select({ status: editions.status }).from(editions).where(eq(editions.id, editionId));
  if (!e) redirect(withFlash("/admin/editions", { error: "Edition not found." }));
  if (e.status === "published") redirect(withFlash(back, { error: "Published editions are immutable; add a correction instead." }));
}
export async function updateStory(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "story_id"); const editionId = num(fd, "edition_id");
  if (!id || !editionId) return;
  const back = `/admin/editions/${editionId}`;
  await editableEdition(editionId, back);
  const keys = ["title_en", "title_ur", "summary_en", "summary_ur", "why_en", "why_ur", "contested_en", "contested_ur", "tag", "coverage", "order", "qa_status", "qa_note"] as const;
  const d = parseOrRedirect(storySchema, Object.fromEntries(keys.map((k) => [k, str(fd, k)])), back);
  await db.update(stories).set({ titleEn: d.title_en, titleUr: d.title_ur, summaryEn: d.summary_en, summaryUr: d.summary_ur, whyEn: d.why_en, whyUr: d.why_ur, contestedEn: d.contested_en, contestedUr: d.contested_ur, tag: d.tag, coverage: d.coverage || null, order: d.order, qaStatus: d.qa_status, qaNote: d.qa_note }).where(eq(stories.id, id));
  revalidatePath(back);
  redirect(withFlash(`${back}#story-${id}`, { ok: `Story ${id} saved.` }));
}
export async function updateLead(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "edition_group_id"); const editionId = num(fd, "edition_id");
  if (!id || !editionId) return;
  const back = `/admin/editions/${editionId}`;
  await editableEdition(editionId, back);
  await db.update(editionGroups).set({ leadEn: str(fd, "lead_en").slice(0, 400), leadUr: str(fd, "lead_ur").slice(0, 400) }).where(eq(editionGroups.id, id));
  revalidatePath(back);
  redirect(withFlash(back, { ok: "Lead saved." }));
}
export async function publishEdition(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const back = `/admin/editions/${id}`;
  const r = await publishEditionById(id, bool(fd, "force"));
  revalidatePath(back); revalidatePath("/admin/editions"); revalidatePath("/admin");
  if ("error" in r) redirect(withFlash(back, { error: r.error }));
  redirect(withFlash(back, r.status === "published" ? { ok: "Published." } : { error: `${r.flagged} flagged stories; held for review. Fix them or publish with force.` }));
}
export async function holdEdition(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = num(fd, "id"); if (!id) return;
  const back = `/admin/editions/${id}`;
  await editableEdition(id, back);
  await db.update(editions).set({ status: "review", updatedAt: new Date() }).where(eq(editions.id, id));
  revalidatePath(back); revalidatePath("/admin/editions");
  redirect(withFlash(back, { ok: "Held for review." }));
}
export async function addCorrection(fd: FormData): Promise<void> {
  await requireAdmin();
  const storyId = num(fd, "story_id"); const editionId = num(fd, "edition_id");
  const textEn = str(fd, "text_en"), textUr = str(fd, "text_ur");
  if (!storyId || !editionId) return;
  const back = `/admin/editions/${editionId}`;
  if (!textEn) redirect(withFlash(back, { error: "Correction text (English) is required." }));
  await db.insert(corrections).values({ storyId, textEn: textEn.slice(0, 2000), textUr: textUr.slice(0, 2000) });
  revalidatePath(back); site();
  redirect(withFlash(`${back}#story-${storyId}`, { ok: "Correction added." }));
}

// ---- settings ---------------------------------------------------------------------------
const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
const settingsSchema = z.object({
  subh: z.string().regex(timeRe), dopahar: z.string().regex(timeRe), shaam: z.string().regex(timeRe),
  publish_policy: z.enum(["auto", "hold"]), editor_name: z.string().max(100), site_name_en: z.string().min(1).max(60), site_name_ur: z.string().min(1).max(60),
  disclosure_en: z.string().max(600), disclosure_ur: z.string().max(600), digits_ur: z.enum(["latn", "arabext"]), default_theme: z.enum(["classic", "night", "buzurg"]),
  hijri_adjust: z.coerce.number().int().min(-3).max(3), ntfy_note: z.string().max(300),
});
export async function saveSettings(fd: FormData): Promise<void> {
  await requireAdmin();
  const keys = ["subh", "dopahar", "shaam", "publish_policy", "editor_name", "site_name_en", "site_name_ur", "disclosure_en", "disclosure_ur", "digits_ur", "default_theme", "hijri_adjust", "ntfy_note"] as const;
  const d = parseOrRedirect(settingsSchema, Object.fromEntries(keys.map((k) => [k, str(fd, k)])), "/admin/settings");
  const values: Record<string, unknown> = {
    edition_times: { subh: d.subh, dopahar: d.dopahar, shaam: d.shaam }, timezone: "Asia/Karachi", publish_policy: d.publish_policy, editor_name: d.editor_name,
    site_name_en: d.site_name_en, site_name_ur: d.site_name_ur, disclosure_en: d.disclosure_en, disclosure_ur: d.disclosure_ur, digits_ur: d.digits_ur,
    default_theme: d.default_theme, hijri_adjust: d.hijri_adjust, ntfy_note: d.ntfy_note,
  };
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(values)) await tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  });
  revalidatePath("/admin/settings"); site();
  redirect(withFlash("/admin/settings", { ok: "Settings saved." }));
}
