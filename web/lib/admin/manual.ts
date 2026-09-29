import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, like, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db";
import type { ImageVariant } from "@/db/schema";
import { httpUrl } from "@/lib/contracts";
import { MANUAL_PLACEMENTS, type JobStatus, type StoryLang } from "@/lib/codes";
import { ensureDraftEdition, ensureEditionGroups, goLiveIfReady, upcomingEdition } from "@/lib/desk";
import { enqueueJob, jobKeys } from "@/lib/jobs";
import { IMAGE_MAX_VARIANT_BYTES, IMAGE_MAX_VARIANT_H, IMAGE_MIN_SOURCE_W, IMAGE_WIDTHS, mediaFileName } from "@/lib/media";
import { storeMediaFile, webpInfo } from "@/lib/media-store";
import { TOPICS } from "@/lib/taxonomy";
import { normalizeUrdu, type Slot } from "@/lib/urdu";
import { getSessionToken, roleAtLeast, type SessionUser } from "@/lib/auth";
import { hashToken, looksLikeToken } from "@/lib/auth/tokens";
import { FetchTimeoutError, looksPublicHost, NotPublicError, publicGet } from "./public-fetch";
import { pgError } from "./util";

/*
 * Manual stories (decision D12 in docs/PLAN.md), the admin side: an editor adds a story by hand from a link.
 *
 * - The link is required and is fetched ONCE, on the web server, through the SSRF-safe public fetch
 *   (./public-fetch.ts), to confirm it exists and to prefill the form (title, description, image, outlet).
 *   "Check link" does that fetch and hands the form a preview signed for the editor's session; the create
 *   step uses the signed preview instead of fetching again (and fetches itself only when there is none).
 *   Fetched text is untrusted data: it only prefills fields the editor then reviews, and is stored as the
 *   item's title and description (never shown as instructions to anyone).
 * - The link becomes the story's cited item: the item already stored for that article (a feed carried it),
 *   else a new item under an inactive `manual` source for the outlet (matched by host, or made now), so a
 *   manual story's citation is as real as the worker's.
 * - Every manual story is origin 'manual', qa_status 'manual' (never AI-verified), with a byline snapshot
 *   (created_by_name) for "Manual entry · added by <name>" / "دستی اندراج · <name>".
 * - A missing language is written by the worker from the editor's text only (fill_language job) and marked
 *   (stories.language_filled); an image is an upload re-encoded here with sharp (like the worker's I2) or the
 *   article's own image, fetched by the worker (story_image job).
 * - Placement (lib/desk.ts): `edition` (the upcoming edition or a held one; out with it) or `desk` (live on
 *   the front page's Editor's desk once ready; joins the next edition that publishes).
 * - Every create, edit, removal, job retry and cancel is written to audit_log.
 */

const { stories, editions, groups, items, itemSources, sources, storySources, images, workerJobs, auditLog, users, articleTranslations } = schema;
type Q = Db | Tx;

// ---- audit ---------------------------------------------------------------------------------

/** One audit_log row: who did what to which target ("story:12", "report:3", "group:2"). */
export async function writeAudit(q: Q, userId: number | null, action: string, target: string, detail: Record<string, unknown> = {}): Promise<void> {
  await q.insert(auditLog).values({ userId, action, target, detail });
}

export async function auditFor(targets: string[], limit = 50) {
  if (!targets.length) return [];
  return db.select({ id: auditLog.id, action: auditLog.action, target: auditLog.target, detail: auditLog.detail, at: auditLog.at, userName: users.name, userEmail: users.email })
    .from(auditLog).leftJoin(users, eq(users.id, auditLog.userId)).where(inArray(auditLog.target, targets)).orderBy(desc(auditLog.at), desc(auditLog.id)).limit(limit);
}

export async function recentAudit(prefixes: string[], limit = 40) {
  if (!prefixes.length) return [];
  return db.select({ id: auditLog.id, action: auditLog.action, target: auditLog.target, detail: auditLog.detail, at: auditLog.at, userName: users.name, userEmail: users.email })
    .from(auditLog).leftJoin(users, eq(users.id, auditLog.userId))
    .where(or(...prefixes.map((p) => like(auditLog.action, `${p}%`)))).orderBy(desc(auditLog.at), desc(auditLog.id)).limit(limit);
}

// ---- URLs (mirrors worker/src/teenpehr/normalize.py) -------------------------------------

const TRACKING_EXACT = new Set(["fbclid", "gclid", "dclid", "msclkid", "igshid", "mc_cid", "mc_eid", "ncid", "cmpid", "ocid", "ref", "ref_src", "ref_url", "referrer", "source", "src", "s", "si", "spm", "yclid", "_ga", "amp", "output", "rss", "feed", "cid"]);
const TRACKING_PREFIX = ["utm_", "pk_", "mtm_", "hsa_", "vero_", "ic_", "at_"];

/**
 * The worker's dedupe key for an article (normalize.py canonical_url): host without www./m./amp., path
 * without doubled or trailing slashes, /amp or /index.html; only non-tracking query parameters, sorted; no
 * scheme or fragment. Keep in step with the Python.
 */
export function canonicalUrl(raw: string): string {
  const u = new URL(raw.trim());
  let host = u.hostname.toLowerCase();
  for (const p of ["www.", "m.", "amp."]) if (host.startsWith(p)) host = host.slice(p.length);
  // The path as written (urlsplit keeps it raw), not URL's re-encoded pathname.
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)(?:\?([^#]*))?/i.exec(raw.trim());
  let path = (m?.[1] ?? u.pathname).replace(/\/{2,}/g, "/").replace(/\/(amp|index\.html?)$/, "");
  if (path.endsWith("/") && path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "/") path = "";
  const params = [...new URLSearchParams(m?.[2] ?? "").entries()]
    .filter(([k, v]) => v !== "" && !TRACKING_EXACT.has(k.toLowerCase()) && !TRACKING_PREFIX.some((p) => k.toLowerCase().startsWith(p)))
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const query = params.length ? new URLSearchParams(params).toString() : "";
  return `${host}${path}${query ? `?${query}` : ""}`;
}

const NON_WORD = new RegExp("[^\\p{L}\\p{N}_]+", "gu");
/** normalize.py content_hash: sha256 of the canonical URL and the title's word key. */
export function contentHash(urlCanonical: string, title: string): string {
  const key = title.toLowerCase().replace(NON_WORD, " ").trim();
  return createHash("sha256").update(`${urlCanonical}\n${key}`).digest("hex");
}

/** Host for matching an outlet: lower case, without www./m./amp. */
export function outletHost(url: string): string {
  let host = new URL(url).hostname.toLowerCase();
  for (const p of ["www.", "m.", "amp."]) if (host.startsWith(p)) host = host.slice(p.length);
  return host;
}

/** An http(s) link on the public internet (the fetch re-checks every address it resolves to). */
export const manualLink = httpUrl.refine((s) => { try { return looksPublicHost(new URL(s).hostname); } catch { return false; } }, "must be a public internet address");

// ---- the link check --------------------------------------------------------------------------

/** What "Check link" learned from the page (untrusted text, cut to size, one line each). */
export const linkPreviewSchema = z.object({
  url: z.string().max(2000),
  finalUrl: z.string().max(2000),
  status: z.number().int(),
  title: z.string().max(300),
  description: z.string().max(1000),
  image: z.string().max(2000).nullable(),
  imageAlt: z.string().max(500).nullable(),
  siteName: z.string().max(120),
  lang: z.string().max(8),
  publishedAt: z.string().max(40).nullable(),
  checkedAt: z.string().max(40),
});
export type LinkPreview = z.infer<typeof linkPreviewSchema>;

export type LinkCheck =
  | { ok: true; preview: LinkPreview }
  /** `overridable`: the page could not be confirmed (blocked, paywall, down) but may exist; the editor may add it anyway. */
  | { ok: false; message: string; overridable: boolean; status?: number };

const FETCH_TIMEOUT_MS = 12_000;
const FETCH_MAX_BYTES = 1_500_000;
const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9,ur;q=0.8",
};

/**
 * Fetch the article once and read its title, description, image, outlet, language and date. The site's
 * robots.txt is read first (CLAUDE.md fetching etiquette): a page it disallows is not fetched at all, and
 * the editor may still add the story "anyway" with the link unchecked (it is cited, never fetched).
 */
export async function checkLink(link: string): Promise<LinkCheck> {
  if (!manualLink.safeParse(link).success) return { ok: false, message: "Enter a full http(s) link to the article on the public internet.", overridable: false };
  const robots = await robotsRefusal(link);
  if (robots) return robots;
  let res;
  try {
    res = await publicGet(link, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES, headers: FETCH_HEADERS });
  } catch (e) {
    if (e instanceof NotPublicError) return { ok: false, message: "That address (or a redirect from it) is not on the public internet.", overridable: false };
    const why = e instanceof FetchTimeoutError ? `no answer in ${FETCH_TIMEOUT_MS / 1000} s` : (e as Error).message.slice(0, 200);
    return { ok: false, overridable: true, message: `Could not reach the page (${why}). The site may be down or blocked from Pakistan (it would need the Germany route).` };
  }
  if (res.status === 404 || res.status === 410) return { ok: false, status: res.status, overridable: false, message: `The page does not exist (HTTP ${res.status}). Check the link.` };
  if (res.status >= 400) {
    const hint = res.status === 401 || res.status === 402 || res.status === 403 ? "the site refuses automated requests or the article is behind a paywall"
      : res.status === 429 ? "the site asks us to slow down (we do not retry)" : "the site had an error";
    return { ok: false, status: res.status, overridable: true, message: `Could not confirm the page: HTTP ${res.status} (${hint}).` };
  }
  const html = res.body;
  const meta = readMeta(html);
  const finalUrl = safeUrl(res.finalUrl) ?? link;
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.trim()) ?? "";
  const title = oneLine(pick("og:title", "twitter:title") || titleTag(html)).slice(0, 300);
  const description = oneLine(pick("og:description", "twitter:description", "description")).slice(0, 1000);
  const image = absUrl(pick("og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"), finalUrl);
  const imageAlt = oneLine(pick("og:image:alt", "twitter:image:alt")).slice(0, 500) || null;
  const siteName = oneLine(pick("og:site_name", "application-name")).slice(0, 120);
  const published = pick("article:published_time", "og:article:published_time", "datepublished", "date", "pubdate", "dc.date.issued");
  const htmlLang = /<html\b[^>]*\blang\s*=\s*["']?([A-Za-z]{2,3})/i.exec(html)?.[1]?.toLowerCase() ?? "";
  const lang = htmlLang || (ARABIC_SCRIPT.test(title) ? "ur" : "en");
  return {
    ok: true,
    preview: { url: link, finalUrl, status: res.status, title, description, image, imageAlt, siteName, lang, publishedAt: saneDate(published), checkedAt: new Date().toISOString() },
  };
}

const ARABIC_SCRIPT = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufefe]/;

// ---- robots.txt (RFC 9309) -------------------------------------------------------------------------

const ROBOTS_TIMEOUT_MS = 6_000;
const ROBOTS_MAX_BYTES = 500_000;
/** Product tokens a site might address us by; otherwise the "*" group applies. */
const ROBOTS_AGENTS = ["tabayyun", "teenpehr"];

/**
 * Why robots.txt stops the link check, or null when the page may be fetched. RFC 9309: a missing robots.txt
 * (4xx) allows everything; a server error means "assume everything is disallowed"; a network failure or a
 * timeout is reported as the page being unreachable (the page fetch would fail the same way).
 */
async function robotsRefusal(link: string): Promise<LinkCheck | null> {
  let url: URL;
  try { url = new URL(link); } catch { return { ok: false, message: "Enter a full http(s) link to the article.", overridable: false }; }
  let res;
  try {
    res = await publicGet(`${url.protocol}//${url.host}/robots.txt`, { timeoutMs: ROBOTS_TIMEOUT_MS, maxBytes: ROBOTS_MAX_BYTES, headers: { ...FETCH_HEADERS, Accept: "text/plain,*/*;q=0.5" } });
  } catch (e) {
    if (e instanceof NotPublicError) return { ok: false, message: "That address (or a redirect from it) is not on the public internet.", overridable: false };
    const why = e instanceof FetchTimeoutError ? `no answer in ${ROBOTS_TIMEOUT_MS / 1000} s` : (e as Error).message.slice(0, 200);
    return { ok: false, overridable: true, message: `Could not reach the site (${why}). It may be down or blocked from Pakistan (it would need the Germany route).` };
  }
  // Overridable: the editor may add the story anyway; its link is then cited, never fetched.
  if (res.status === 429) return { ok: false, status: 429, overridable: true, message: "The site asks us to slow down (HTTP 429 on robots.txt); we do not retry, so the page was not fetched." };
  if (res.status >= 500) return { ok: false, status: res.status, overridable: true, message: `The site's robots.txt answered HTTP ${res.status}, which means nothing may be fetched for now, so the page was not fetched.` };
  if (res.status >= 400 || !res.body) return null;
  if (robotsAllows(res.body, url.pathname + url.search)) return null;
  return { ok: false, overridable: true, message: "The site's robots.txt does not allow automated fetching of this page, so it was not fetched." };
}

/** Whether robots.txt text lets our "*" (or named) group fetch `path` (path and query, percent-encoded as in a URL). */
export function robotsAllows(txt: string, path: string, agents: string[] = ROBOTS_AGENTS): boolean {
  type Group = { agents: string[]; rules: Array<{ allow: boolean; pattern: string }> };
  const groups: Group[] = [];
  let cur: Group | null = null, inAgents = false;
  for (const raw of txt.split(/\r\n|\r|\n/).slice(0, 10_000)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*$/, ""));
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2];
    if (key === "user-agent") {
      if (!cur || !inAgents) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      inAgents = true;
    } else if (key === "allow" || key === "disallow") {
      if (cur && value) cur.rules.push({ allow: key === "allow", pattern: value });
      inAgents = false;
    } else if (key !== "sitemap") inAgents = false;
  }
  const named = groups.filter((g) => g.agents.some((a) => agents.includes(a)));
  const rules = (named.length ? named : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* keep the encoded form */ }
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    if (r.pattern.length > 500 || (r.pattern.match(/\*/g)?.length ?? 0) > 10) continue;
    const anchored = r.pattern.endsWith("$");
    const body = (anchored ? r.pattern.slice(0, -1) : r.pattern).replace(/\*+/g, "*");
    const re = new RegExp(`^${body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
    if (!re.test(path) && !re.test(decoded)) continue;
    // The longest (most specific) rule wins; on a tie, allow.
    if (!best || body.length > best.len || (body.length === best.len && r.allow)) best = { allow: r.allow, len: body.length };
  }
  return best ? best.allow : true;
}

/** Every <meta> content by lower-cased property/name/itemprop (first one wins), from the page's first 400 KB. */
function readMeta(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const head = html.slice(0, 400_000);
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const a of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs.set(a[1].toLowerCase(), a[3] ?? a[4] ?? a[5] ?? "");
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !out.has(key)) out.set(key, decodeEntities(content));
  }
  return out;
}
function titleTag(html: string): string {
  return decodeEntities(/<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(html.slice(0, 400_000))?.[1] ?? "");
}
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
/** One plain line: tags dropped, control characters and runs of whitespace become one space. */
function oneLine(s: string): string {
  return Array.from(s.replace(/<[^>]{0,500}>/g, " "), (c) => (c.charCodeAt(0) < 32 || c === "\u007f" ? " " : c)).join("").replace(/\s+/g, " ").trim();
}
function safeUrl(s: string): string | null {
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}
function absUrl(s: string, base: string): string | null {
  if (!s.trim()) return null;
  try { const u = new URL(s.trim(), base); return (u.protocol === "http:" || u.protocol === "https:") && u.toString().length <= 2000 ? u.toString() : null; } catch { return null; }
}
/** An ISO timestamp for a plausible publication date (1990 to a day from now), else null. */
function saneDate(s: string): string | null {
  if (!s) return null;
  const t = Date.parse(s.trim());
  if (!Number.isFinite(t) || t < Date.UTC(1990, 0, 1) || t > Date.now() + 86_400_000) return null;
  return new Date(t).toISOString();
}

/**
 * Who already has this article: the stored item (a feed carried it; the story will cite that item) and the
 * outlet's feeds by host (the new manual source borrows the first one's name and perspective).
 */
export async function linkOwner(link: string): Promise<{ item: { id: number; title: string; source: string; kind: string } | null; outlet: { name: string; perspective: string; kind: string } | null }> {
  let urlCanonical: string, host: string;
  try { urlCanonical = canonicalUrl(link); host = outletHost(link); } catch { return { item: null, outlet: null }; }
  const [item] = await db.select({ id: items.id, title: items.title, source: sources.name, kind: sources.kind }).from(items)
    .innerJoin(sources, eq(sources.id, items.sourceId)).where(eq(items.urlCanonical, urlCanonical));
  const all = await db.select({ url: sources.url, name: sources.name, perspective: sources.perspective, kind: sources.kind }).from(sources).where(isNull(sources.archivedAt)).orderBy(asc(sources.id));
  const outlet = all.find((s) => { try { return outletHost(s.url) === host; } catch { return false; } }) ?? null;
  return { item: item ?? null, outlet: outlet ? { name: outlet.name, perspective: outlet.perspective, kind: outlet.kind } : null };
}

// ---- signing (a check or an upload, for this editor's session) ---------------------------------

async function sessionKey(): Promise<string | null> {
  const raw = await getSessionToken();
  return looksLikeToken(raw) ? hashToken(raw) : null;
}
const mac = (key: string, purpose: string, body: string) => createHmac("sha256", key).update(`tabayyun:${purpose}\0${body}`).digest("base64url");

/** Sign `body` (a JSON string) for this session, so a later form post can prove the server made it. */
export async function signForSession(purpose: "manual-link" | "manual-image", body: string): Promise<string | null> {
  const key = await sessionKey();
  return key ? mac(key, purpose, body) : null;
}
export async function verifyForSession(purpose: "manual-link" | "manual-image", body: string, sig: string): Promise<boolean> {
  const key = await sessionKey();
  if (!key || !body || !sig) return false;
  const want = Buffer.from(mac(key, purpose, body), "base64url");
  let got: Buffer;
  try { got = Buffer.from(sig, "base64url"); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A signed preview for `link`, checked less than two hours ago; else null (the create step fetches). */
export async function trustedPreview(link: string, json: string, sig: string): Promise<LinkPreview | null> {
  if (!json || !sig || !(await verifyForSession("manual-link", json, sig))) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const p = linkPreviewSchema.safeParse(parsed);
  if (!p.success || p.data.url !== link) return null;
  const age = Date.now() - Date.parse(p.data.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < 2 * 3_600_000 ? p.data : null;
}

// ---- image upload (re-encoded and stripped like the worker's I2) ------------------------------

export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"] as const;
const UPLOAD_FORMATS = new Set(["jpeg", "png", "webp", "avif", "heif", "gif"]);

export const uploadedImageSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  variants: z.array(z.object({ w: z.number().int().positive(), h: z.number().int().positive(), file: z.string(), bytes: z.number().int().positive(), mime: z.literal("image/webp") })).min(1).max(2),
});
export type UploadedImage = z.infer<typeof uploadedImageSchema>;

export class UploadError extends Error {}

/**
 * Re-encode an editor's upload the way the worker does a publisher's image (D6/I2): orientation applied,
 * sRGB, every bit of metadata stripped, WebP at 480 and 960 px wide (never upscaled; a narrower original
 * gives one variant at its own width), each under the upload limit and checked as a still WebP of exactly
 * its size, stored content-addressed in MEDIA_DIR. Files nobody's story shows are never served to readers.
 */
export async function processUpload(buf: Buffer): Promise<UploadedImage> {
  if (buf.length > UPLOAD_MAX_BYTES) throw new UploadError(`The image is larger than ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
  let sharp: typeof import("sharp").default;
  try { sharp = (await import("sharp")).default; } catch {
    throw new UploadError("Image processing is not available on this server. Choose \"Use the article's image\" instead.");
  }
  const opts = { failOn: "error" as const, limitInputPixels: 40_000_000, pages: 1 };
  let meta;
  try { meta = await sharp(buf, opts).metadata(); } catch { throw new UploadError("That file is not an image we can read (JPEG, PNG, WebP, AVIF or GIF)."); }
  if (!meta.format || !UPLOAD_FORMATS.has(meta.format)) throw new UploadError(`Unsupported image type (${meta.format ?? "unknown"}). Use JPEG, PNG, WebP, AVIF or GIF.`);
  const W = meta.autoOrient?.width ?? meta.width ?? 0, H = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!W || !H) throw new UploadError("Could not read the image's size.");
  if (W < IMAGE_MIN_SOURCE_W) throw new UploadError(`The image is ${W} px wide; it must be at least ${IMAGE_MIN_SOURCE_W} px.`);
  const widths: number[] = IMAGE_WIDTHS.filter((w) => w <= W);
  if (!widths.length) widths.push(W);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const variants: ImageVariant[] = [];
  for (const w of widths) {
    let out: Buffer | null = null;
    for (const quality of [82, 72, 62, 52, 42]) {
      const data = await sharp(buf, opts).autoOrient().toColourspace("srgb").resize({ width: w, withoutEnlargement: true }).webp({ quality, effort: 4 }).toBuffer();
      if (data.length <= IMAGE_MAX_VARIANT_BYTES) { out = data; break; }
    }
    if (!out) throw new UploadError("The image stays too large after compression; try a smaller one.");
    const info = webpInfo(out);
    if (!info || info.width !== w) throw new UploadError("Re-encoding produced an unexpected file; try another image.");
    if (info.height > IMAGE_MAX_VARIANT_H) throw new UploadError("The image is too tall for a story picture; crop it first.");
    const file = mediaFileName(sha256, w);
    const stored = await storeMediaFile(file, out, w);
    variants.push({ w: stored.w, h: stored.h, file, bytes: stored.bytes, mime: "image/webp" });
  }
  const { dominant } = await sharp(buf, opts).autoOrient().toColourspace("srgb").stats();
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return { sha256, width: W, height: H, color: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`, variants };
}

export async function trustedUpload(json: string, sig: string): Promise<UploadedImage | null> {
  if (!json || !sig || !(await verifyForSession("manual-image", json, sig))) return null;
  try {
    const p = uploadedImageSchema.safeParse(JSON.parse(json));
    return p.success && p.data.variants.every((v) => v.file === mediaFileName(p.data.sha256, v.w)) ? p.data : null;
  } catch { return null; }
}

// ---- the form's input ------------------------------------------------------------------------

const TAGS = ["must-read", "worth-knowing", "skim"] as const;
const COVERAGES = ["broad", "partisan", "single-source"] as const;
export const MANUAL_TEXT_MAX = { title: 300, summary: 3000, why: 1000, contested: 1000 } as const;

const en = (max: number) => z.string().max(max).transform((s) => s.trim());
const urd = (max: number) => z.string().max(max).transform((s) => normalizeUrdu(s.trim()));

export const storyTextSchema = z.object({
  group_id: z.coerce.number({ error: "choose one" }).int().positive("choose one").max(2_147_483_647),
  tag: z.enum(TAGS, { error: "choose one" }),
  coverage: z.enum(COVERAGES, { error: "choose one" }),
  topics: z.array(z.enum(TOPICS)).max(3, "choose at most 3 topics"),
  position: z.enum(["top", "end"]),
  title_en: en(MANUAL_TEXT_MAX.title), summary_en: en(MANUAL_TEXT_MAX.summary), why_en: en(MANUAL_TEXT_MAX.why), contested_en: en(MANUAL_TEXT_MAX.contested),
  title_ur: urd(MANUAL_TEXT_MAX.title), summary_ur: urd(MANUAL_TEXT_MAX.summary), why_ur: urd(MANUAL_TEXT_MAX.why), contested_ur: urd(MANUAL_TEXT_MAX.contested),
});
export type StoryText = {
  group_id: number; tag: (typeof TAGS)[number]; coverage: (typeof COVERAGES)[number]; topics: (typeof TOPICS)[number][]; position: "top" | "end";
  title_en: string; summary_en: string; why_en: string; contested_en: string; title_ur: string; summary_ur: string; why_ur: string; contested_ur: string;
};

export const manualStorySchema = storyTextSchema.extend({
  link: manualLink,
  placement: z.enum(MANUAL_PLACEMENTS, { error: "choose one" }),
  // For `edition`: "upcoming", or the id of a held (or draft) edition.
  edition: z.union([z.literal("upcoming"), z.coerce.number().int().positive().max(2_147_483_647)]),
  image: z.enum(["none", "article", "upload"]),
  // Readers see both (the credit line and the alt text): Urdu typed on any keyboard layout is mapped to Urdu code points.
  image_credit: z.string().max(120).transform((s) => normalizeUrdu(oneLine(s))),
  image_alt: z.string().max(500).transform((s) => normalizeUrdu(oneLine(s))),
  image_graphic: z.boolean(),
  image_rights: z.boolean(),
  unchecked_ok: z.boolean(),
});
export type ManualStoryIn = z.infer<typeof manualStorySchema>;

/** Which languages the editor wrote, or a problem with a half-written one. */
export function languagesOf(d: StoryText): { complete: StoryLang[]; missing: StoryLang[]; problem?: string } {
  const complete: StoryLang[] = [], missing: StoryLang[] = [];
  for (const lang of ["en", "ur"] as const) {
    const [title, summary, why, contested] = (["title", "summary", "why", "contested"] as const).map((f) => d[`${f}_${lang}`]);
    const name = lang === "en" ? "English" : "Urdu";
    if (title && summary) complete.push(lang);
    else if (!title && !summary && !why && !contested) missing.push(lang);
    else return { complete, missing, problem: `${name}: write both a title and a summary, or leave every ${name} field empty for the worker to write it from your other language.` };
  }
  if (!complete.length) return { complete, missing, problem: "Write the title and summary in English or in Urdu (or both)." };
  return { complete, missing };
}

/** English words a story shows and the time to read them at 220 a minute (the edition PUT's rule). */
function readingStats(s: { titleEn: string; summaryEn: string; whyEn: string; contestedEn: string }) {
  const words = `${s.titleEn} ${s.summaryEn} ${s.whyEn} ${s.contestedEn}`.split(/\s+/).filter(Boolean).length;
  return words ? { wordCount: words, readingTimeSec: Math.ceil((words * 60) / 220) } : { wordCount: null, readingTimeSec: null };
}

const ORDER = { top: 0, end: 99 } as const;

/** The byline readers see: the editor's name, else a neutral "Editor" (never part of an email address). */
export function bylineOf(user: Pick<SessionUser, "name">): string {
  return user.name.trim().slice(0, 80) || "Editor";
}

// ---- where a story can go ------------------------------------------------------------------

export type Destination = { id: number | null; date: string; slot: Slot; status: "draft" | "review"; stories: number; label: string };

/** The upcoming edition (maybe not created yet) and the editions held for review, for the destination choice. */
export async function destinations(): Promise<{ upcoming: Destination | null; held: Destination[]; error?: string }> {
  let upcoming: Destination | null = null, error: string | undefined;
  try {
    const u = await upcomingEdition(db);
    const n = u.id ? await db.$count(stories, eq(stories.editionId, u.id)) : 0;
    upcoming = { id: u.id, date: u.date, slot: u.slot, status: "draft", stories: n, label: `${u.date} ${u.slot}` };
  } catch (e) { error = (e as Error).message; }
  const heldRows = await db.select({ id: editions.id, date: editions.date, slot: editions.slot, n: sql<number>`(select count(*)::int from ${stories} where ${stories.editionId} = ${editions.id})` })
    .from(editions).where(eq(editions.status, "review")).orderBy(desc(editions.date), desc(editions.slot)).limit(20);
  const held = heldRows.map((r) => ({ id: r.id, date: r.date, slot: r.slot as Slot, status: "review" as const, stories: Number(r.n), label: `${r.date} ${r.slot}` }));
  return { upcoming, held, error };
}

// ---- create ------------------------------------------------------------------------------

export type CreateResult = { ok: true; id: number; edition: { id: number; date: string; slot: string }; live: boolean; jobs: string[] } | { ok: false; error: string };

class Refused extends Error {}

/**
 * Create a manual story in one transaction (the recipe in lib/desk.ts and docs/PLAN.md D12). `preview` is
 * the page as the link check saw it (null when it could not be confirmed and the editor chose to add it
 * anyway); `upload` an image already re-encoded and stored by processUpload.
 */
export async function createManualStory(user: SessionUser, d: ManualStoryIn, preview: LinkPreview | null, upload: UploadedImage | null): Promise<CreateResult> {
  if (!roleAtLeast(user.role, "editor")) return { ok: false, error: "Editors and owners only." };
  const langs = languagesOf(d);
  if (langs.problem) return { ok: false, error: langs.problem };
  if (d.image === "upload" && !upload) return { ok: false, error: "Upload the image again (the upload was not received or has expired), or choose another image option." };
  if (d.image === "upload" && !d.image_credit) return { ok: false, error: "Say whose image it is (the credit readers see)." };
  if (d.image === "upload" && !d.image_rights) return { ok: false, error: "Confirm the image may be used (it is the article's own picture, or you have the right to use it)." };
  const byline = bylineOf(user);
  const link = preview ? preview.finalUrl || d.link : d.link;
  try {
    const out = await db.transaction(async (tx) => {
      const [group] = await tx.select({ id: groups.id, active: groups.active, slug: groups.slug }).from(groups).where(eq(groups.id, d.group_id));
      if (!group || !group.active) throw new Refused("Choose an active section.");

      const item = await resolveItem(tx, link, d, preview, group.id, user);

      // The edition: the upcoming one (created as a draft when missing), or the held/draft one chosen.
      let editionId: number;
      if (d.placement === "desk" || d.edition === "upcoming") {
        const u = await upcomingEdition(tx).catch((e: Error) => { throw new Refused(`Could not work out the next edition (${e.message}). Choose a held edition.`); });
        editionId = u.id ?? (await ensureDraftEdition(tx, u.date, u.slot)).id;
      } else {
        editionId = d.edition;
      }
      // Lock it: a publish racing this either waits (and publishes the story with it) or is seen here.
      const [ed] = await tx.select({ id: editions.id, date: editions.date, slot: editions.slot, status: editions.status }).from(editions).where(eq(editions.id, editionId)).for("update");
      if (!ed) throw new Refused("That edition no longer exists. Choose another.");
      if (ed.status === "published") throw new Refused(`Edition ${ed.date} ${ed.slot} was published a moment ago. Choose the next one.`);
      // A chosen edition must be one held for review (what the form offers): an old or far-off draft may never
      // be published, and a story put there would never reach readers.
      if (d.placement === "edition" && d.edition !== "upcoming" && ed.status !== "review") {
        throw new Refused(`Edition ${ed.date} ${ed.slot} is not held for review any more. Choose the next edition or another held one.`);
      }

      const text = {
        titleEn: d.title_en, summaryEn: d.summary_en, whyEn: d.why_en, contestedEn: d.contested_en,
        titleUr: d.title_ur, summaryUr: d.summary_ur, whyUr: d.why_ur, contestedUr: d.contested_ur,
      };
      const [story] = await tx.insert(stories).values({
        editionId: ed.id, groupId: group.id, order: ORDER[d.position], ...text, tag: d.tag, coverage: d.coverage,
        qaStatus: "manual", qaNote: "", origin: "manual", createdBy: user.id, createdByName: byline, placement: d.placement,
        topics: d.topics, ...readingStats(text),
      }).returning({ id: stories.id });
      await tx.insert(storySources).values({ storyId: story.id, itemId: item.id, isPrimary: true });

      if (upload) {
        const imageId = await insertUploadedImage(tx, upload, item, d, user);
        await tx.update(stories).set({ imageId }).where(eq(stories.id, story.id));
      }
      await ensureEditionGroups(tx, ed.id);

      const jobs: string[] = [];
      // Editor-facing work goes before batch work; a desk story someone wants live now goes first.
      const priority = d.placement === "desk" ? 6 : 3;
      for (const lang of langs.missing) {
        await enqueueJob("fill_language", { story_id: story.id, lang }, { dedupeKey: jobKeys.fill(story.id, lang), requestedBy: user.id, priority, tx });
        jobs.push(`fill_language (${lang === "en" ? "English" : "Urdu"})`);
      }
      if (d.image === "article") {
        await enqueueJob("story_image", { story_id: story.id, item_id: item.id }, { dedupeKey: jobKeys.image(story.id), requestedBy: user.id, priority, tx });
        jobs.push("story_image");
      }
      const live = d.placement === "desk" ? await goLiveIfReady(tx, story.id) : false;
      await writeAudit(tx, user.id, "manual_story.create", `story:${story.id}`, {
        link, item_id: item.id, item_reused: item.reused, source_id: item.sourceId, placement: d.placement, edition: `${ed.date} ${ed.slot}`,
        group: group.slug, languages: langs.complete, filled_by_worker: langs.missing, image: d.image, link_checked: !!preview, live,
      });
      return { ok: true as const, id: story.id, edition: { id: ed.id, date: ed.date, slot: ed.slot }, live, jobs };
    });
    return out;
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
}

type ResolvedItem = { id: number; sourceId: number; reused: boolean };

/**
 * The item the story cites: the one already stored for this article (a feed carried it), else a new one
 * under the outlet's inactive `manual` source (found by host, or made now in the story's section).
 */
async function resolveItem(tx: Tx, link: string, d: ManualStoryIn, preview: LinkPreview | null, groupId: number, user: SessionUser): Promise<ResolvedItem> {
  const urlCanonical = canonicalUrl(link);
  const [existing] = await tx.select({ id: items.id, sourceId: items.sourceId }).from(items).where(eq(items.urlCanonical, urlCanonical));
  if (existing) return { ...existing, reused: true };

  const host = outletHost(link);
  const sourceId = await manualSourceFor(tx, host, groupId, preview);
  const title = preview?.title || d.title_en || d.title_ur;
  const text = preview?.description ?? "";
  const lang = preview?.lang && /^[a-z]{2,3}$/.test(preview.lang) ? preview.lang : ARABIC_SCRIPT.test(title) ? "ur" : "en";
  const [made] = await tx.insert(items).values({
    sourceId, url: link, urlCanonical, title: title.slice(0, 500), text, publishedAt: preview?.publishedAt ? new Date(preview.publishedAt) : null,
    lang, contentHash: contentHash(urlCanonical, title), description: preview?.description || null, imageUrl: preview?.image ?? null,
    siteName: preview?.siteName || null, fetch: preview ? { via: "admin-manual", status: preview.status } : { via: "admin-manual-unchecked" },
    raw: { origin: "manual", added_by: user.id, link_checked: !!preview, ...(preview?.imageAlt ? { image_alt: preview.imageAlt } : {}) },
  }).onConflictDoNothing({ target: items.urlCanonical }).returning({ id: items.id, sourceId: items.sourceId });
  // The worker stored the same article a moment ago: cite that one.
  const row = made ?? (await tx.select({ id: items.id, sourceId: items.sourceId }).from(items).where(eq(items.urlCanonical, urlCanonical)))[0];
  if (!row) throw new Error(`item ${urlCanonical} vanished`);
  await tx.insert(itemSources).values({ itemId: row.id, sourceId: row.sourceId }).onConflictDoNothing();
  return { ...row, reused: !made };
}

/** The outlet's inactive `manual` source: an existing one for this host (this section first), else a new one. */
async function manualSourceFor(tx: Tx, host: string, groupId: number, preview: LinkPreview | null): Promise<number> {
  const hostOf = (u: string) => { try { return outletHost(u); } catch { return ""; } };
  const all = await tx.select({ id: sources.id, groupId: sources.groupId, kind: sources.kind, url: sources.url, name: sources.name, perspective: sources.perspective, lang: sources.lang })
    .from(sources).where(isNull(sources.archivedAt)).orderBy(asc(sources.id));
  const sameHost = all.filter((s) => hostOf(s.url) === host);
  const manual = sameHost.filter((s) => s.kind === "manual").sort((a, b) => Number(b.groupId === groupId) - Number(a.groupId === groupId))[0];
  if (manual) return manual.id;
  // A feed of the same outlet lends its name, perspective and language (readers see the perspective label).
  const feed = sameHost.sort((a, b) => Number(b.groupId === groupId) - Number(a.groupId === groupId))[0];
  const name = (feed?.name.replace(/\s*[(\[](rss|feed|atom|youtube|gnews|google news)[)\]]\s*$/i, "") || preview?.siteName || host).slice(0, 120);
  const url = `https://${host}/`;
  const [made] = await tx.insert(sources).values({
    groupId, name, kind: "manual", url, lang: feed?.lang ?? (preview?.lang && /^[a-z]{2,3}$/.test(preview.lang) ? preview.lang : "en"),
    perspective: feed?.perspective ?? "", active: false, maxItems: 1,
    notes: "Holds links editors added by hand (manual stories, D12). Inactive: the worker never fetches it.",
  }).onConflictDoNothing({ target: [sources.groupId, sources.url] }).returning({ id: sources.id });
  if (made) return made.id;
  // A source with exactly this address already exists in the section (the outlet's home page): use it.
  const [same] = await tx.select({ id: sources.id }).from(sources).where(and(eq(sources.groupId, groupId), eq(sources.url, url)));
  if (!same) throw new Error(`source ${url} vanished`);
  return same.id;
}

async function insertUploadedImage(tx: Tx, up: UploadedImage, item: ResolvedItem, d: ManualStoryIn, user: SessionUser): Promise<number> {
  const [row] = await tx.insert(images).values({
    sha256: up.sha256, sourceUrl: `upload:editor:${user.id}`, itemId: item.id, postId: null, sourceId: item.sourceId,
    credit: d.image_credit.slice(0, 120), alt: d.image_alt || null, width: up.width, height: up.height, color: up.color,
    graphic: d.image_graphic, variants: up.variants,
  }).onConflictDoNothing().returning({ id: images.id });
  if (row) return row.id;
  const [same] = await tx.select({ id: images.id }).from(images).where(and(eq(images.sha256, up.sha256), eq(images.itemId, item.id)));
  if (!same) throw new Error("image row could not be written");
  return same.id;
}

// ---- reading manual stories ------------------------------------------------------------------

export type ManualState = "published" | "desk" | "scheduled" | "waiting";
export type ManualJob = { id: number; kind: string; status: JobStatus; attempts: number; maxAttempts: number; error: string | null; lang: string | null; updatedAt: Date };

/**
 * published: out with a published edition; desk: live on the Editor's desk; scheduled: ready, goes out with its
 * edition; waiting: not ready (a language or a job outstanding), or a ready desk story not live yet.
 */
function stateOf(s: { deskAt: Date | null; placement: string | null }, editionStatus: string, ready: boolean): ManualState {
  if (editionStatus === "published") return "published";
  if (s.deskAt) return "desk";
  return ready && s.placement === "edition" ? "scheduled" : "waiting";
}

const storyJobKinds = ["fill_language", "story_image"] as const;

async function jobsByStory(ids: number[]): Promise<Map<number, ManualJob[]>> {
  const out = new Map<number, ManualJob[]>();
  if (!ids.length) return out;
  const rows = await db.select({
    id: workerJobs.id, kind: workerJobs.kind, status: workerJobs.status, attempts: workerJobs.attempts, maxAttempts: workerJobs.maxAttempts,
    error: workerJobs.error, updatedAt: workerJobs.updatedAt, storyId: sql<string>`${workerJobs.payload}->>'story_id'`, lang: sql<string | null>`${workerJobs.payload}->>'lang'`,
  }).from(workerJobs).where(and(inArray(workerJobs.kind, [...storyJobKinds]), inArray(sql`${workerJobs.payload}->>'story_id'`, ids.map(String)))).orderBy(desc(workerJobs.id));
  for (const r of rows) {
    const id = Number(r.storyId);
    out.set(id, [...(out.get(id) ?? []), { id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, maxAttempts: r.maxAttempts, error: r.error, lang: r.lang, updatedAt: r.updatedAt }]);
  }
  return out;
}

const complete = (s: { titleEn: string; summaryEn: string; titleUr: string; summaryUr: string }) => !!(s.titleEn && s.summaryEn && s.titleUr && s.summaryUr);

export type ManualFilter = { mine?: number; state?: ManualState | "" };

export async function listManualStories(f: ManualFilter = {}, limit = 150) {
  const rows = await db.select({
    id: stories.id, titleEn: stories.titleEn, titleUr: stories.titleUr, summaryEn: stories.summaryEn, summaryUr: stories.summaryUr,
    placement: stories.placement, deskAt: stories.deskAt, languageFilled: stories.languageFilled, createdAt: stories.createdAt,
    createdBy: stories.createdBy, createdByName: stories.createdByName, imageId: stories.imageId, tag: stories.tag,
    editionId: editions.id, editionDate: editions.date, editionSlot: editions.slot, editionStatus: editions.status, publishedAt: editions.publishedAt,
    groupName: groups.nameEn,
  }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId)).innerJoin(groups, eq(groups.id, stories.groupId))
    .where(and(eq(stories.origin, "manual"), f.mine ? eq(stories.createdBy, f.mine) : undefined))
    .orderBy(desc(stories.createdAt), desc(stories.id)).limit(limit);
  const jobs = await jobsByStory(rows.map((r) => r.id));
  const out = rows.map((r) => {
    const js = jobs.get(r.id) ?? [];
    const pending = js.some((j) => j.status === "queued" || j.status === "running");
    const ready = complete(r) && !pending;
    return { ...r, jobs: js, ready, state: stateOf(r, r.editionStatus, ready) };
  });
  return f.state ? out.filter((r) => r.state === f.state) : out;
}

export async function getManualStory(id: number) {
  const s = await db.query.stories.findFirst({
    where: and(eq(stories.id, id), eq(stories.origin, "manual")),
    columns: { searchEn: false, searchUr: false },
    with: {
      edition: true, group: true, image: { columns: { sourceUrl: false } }, corrections: true,
      sources: { with: { item: { columns: { search: false, raw: false }, with: { source: true } } } },
    },
  });
  if (!s) return null;
  const js = (await jobsByStory([id])).get(id) ?? [];
  const pending = js.some((j) => j.status === "queued" || j.status === "running");
  const ready = complete(s) && !pending;
  const [creator] = s.createdBy ? await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, s.createdBy)) : [];
  return { ...s, jobs: js, ready, state: stateOf(s, s.edition.status, ready), creator: creator ?? null, live: s.edition.status === "published" || !!s.deskAt };
}
export type ManualStoryFull = NonNullable<Awaited<ReturnType<typeof getManualStory>>>;

// ---- edit, go live, remove -------------------------------------------------------------------

/**
 * Lock a manual story for a change: the edition row first (the order a publish takes its locks in), then
 * the story row, re-read under the locks. Refuses a story that is live (published, or on the desk).
 */
async function lockManual(tx: Tx, id: number): Promise<{ story: typeof stories.$inferSelect; edition: { id: number; date: string; slot: string; status: string } }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [peek] = await tx.select({ editionId: stories.editionId }).from(stories).where(and(eq(stories.id, id), eq(stories.origin, "manual")));
    if (!peek) throw new Refused("That manual story no longer exists.");
    const [ed] = await tx.select({ id: editions.id, date: editions.date, slot: editions.slot, status: editions.status }).from(editions).where(eq(editions.id, peek.editionId)).for("update");
    const [story] = await tx.select().from(stories).where(and(eq(stories.id, id), eq(stories.editionId, peek.editionId))).for("update");
    if (!story || !ed) continue; // moved to another edition meanwhile (a publish deferred it): look again
    if (ed.status === "published") throw new Refused(`Story ${id} is published in ${ed.date} ${ed.slot}: it can no longer be changed; add a correction from the edition page.`);
    if (story.deskAt) throw new Refused(`Story ${id} is live on the Editor's desk: it can no longer be changed; add a correction from the edition page.`);
    return { story, edition: ed };
  }
  throw new Refused("The story kept moving between editions; reload and try again.");
}

export type EditIn = StoryText & { reviewed_filled: boolean };

/** Edit a manual story that is not live yet. A language the editor now wrote cancels its queued fill; one they emptied is queued for the worker. */
export async function updateManualStory(user: SessionUser, id: number, d: EditIn): Promise<{ ok: true; live: boolean; notes: string[] } | { ok: false; error: string }> {
  const langs = languagesOf(d);
  if (langs.problem) return { ok: false, error: langs.problem };
  try {
    return await db.transaction(async (tx) => {
      const { story, edition } = await lockManual(tx, id);
      const [group] = await tx.select({ id: groups.id, active: groups.active }).from(groups).where(eq(groups.id, d.group_id));
      if (!group || (!group.active && group.id !== story.groupId)) throw new Refused("Choose an active section.");
      const text = {
        titleEn: d.title_en, summaryEn: d.summary_en, whyEn: d.why_en, contestedEn: d.contested_en,
        titleUr: d.title_ur, summaryUr: d.summary_ur, whyUr: d.why_ur, contestedUr: d.contested_ur,
      };
      const notes: string[] = [];
      // The worker's side stays marked as filled unless the editor says they reviewed (and own) it now.
      const filled = story.languageFilled && !d.reviewed_filled && !langs.missing.includes(story.languageFilled) ? story.languageFilled : null;
      await tx.update(stories).set({
        ...text, groupId: group.id, tag: d.tag, coverage: d.coverage, topics: d.topics, order: ORDER[d.position], languageFilled: filled, ...readingStats(text),
      }).where(eq(stories.id, id));
      if (story.languageFilled && !filled) notes.push("The 'filled by the worker' mark was cleared.");
      // Both languages must state the same facts: a worker-filled side written from text the editor has now
      // changed is stale. Say so (emptying it has the worker write it again from the new text).
      if (filled) {
        const from = filled === "ur" ? "En" : "Ur";
        const changed = (["title", "summary", "why", "contested"] as const).some((f) => story[`${f}${from}`] !== text[`${f}${from}`]);
        if (changed) notes.push(`Check the ${filled === "ur" ? "Urdu" : "English"}: the worker wrote it from your earlier ${filled === "ur" ? "English" : "Urdu"}, which you changed. Empty it to have it written again from the new text.`);
      }
      for (const lang of ["en", "ur"] as const) {
        const key = jobKeys.fill(id, lang);
        if (langs.complete.includes(lang)) {
          const cancelled = await tx.update(workerJobs).set({ status: "failed", error: `cancelled: ${bylineOf(user)} wrote the ${lang === "en" ? "English" : "Urdu"} text`, finishedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(workerJobs.dedupeKey, key), eq(workerJobs.status, "queued"))).returning({ id: workerJobs.id });
          if (cancelled.length) notes.push(`The queued ${lang === "en" ? "English" : "Urdu"} fill was cancelled (you wrote it).`);
        } else {
          // enqueueJob returns a done (or blocked) job under the same key as it is, so a language the worker
          // already wrote and the editor has now emptied would never be written again and the story would wait
          // for ever. Detach that earlier job from the key (it stays in the story's job history) first.
          await tx.update(workerJobs).set({ dedupeKey: null, updatedAt: new Date() })
            .where(and(eq(workerJobs.dedupeKey, key), inArray(workerJobs.status, ["done", "blocked"])));
          const j = await enqueueJob("fill_language", { story_id: id, lang }, { dedupeKey: key, requestedBy: user.id, priority: story.placement === "desk" ? 6 : 3, tx });
          if (j.created || j.requeued) notes.push(`The worker will write the ${lang === "en" ? "English" : "Urdu"} text from yours.`);
        }
      }
      await ensureEditionGroups(tx, edition.id);
      if (group.id !== story.groupId) await dropEmptyGroupRow(tx, edition.id, story.groupId);
      const live = story.placement === "desk" ? await goLiveIfReady(tx, id) : false;
      await writeAudit(tx, user.id, "manual_story.edit", `story:${id}`, { edition: `${edition.date} ${edition.slot}`, languages: langs.complete, live });
      return { ok: true as const, live, notes };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
}

/** Why a desk story is not live yet, in words; empty when it is ready. */
export function notReadyReasons(s: { titleEn: string; summaryEn: string; titleUr: string; summaryUr: string }, jobs: ManualJob[]): string[] {
  const out: string[] = [];
  if (!s.titleEn || !s.summaryEn) out.push("the English text is not written yet");
  if (!s.titleUr || !s.summaryUr) out.push("the Urdu text is not written yet");
  for (const j of jobs) if (j.status === "queued" || j.status === "running") out.push(`${j.kind === "story_image" ? "the image" : `the ${j.lang === "en" ? "English" : "Urdu"} fill`} is ${j.status}`);
  return out;
}

/** Put a ready desk story live now (normally automatic when its last job ends). */
export async function goLiveNow(user: SessionUser, id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    return await db.transaction(async (tx) => {
      const { story, edition } = await lockManual(tx, id);
      if (story.placement !== "desk") throw new Refused("This story goes out with its edition, not on the Editor's desk.");
      const live = await goLiveIfReady(tx, id);
      if (!live) {
        const js = (await jobsByStory([id])).get(id) ?? [];
        throw new Refused(`Not ready yet: ${notReadyReasons(story, js).join("; ") || "unknown reason"}.`);
      }
      await writeAudit(tx, user.id, "manual_story.go_live", `story:${id}`, { edition: `${edition.date} ${edition.slot}` });
      return { ok: true as const };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * Remove a manual story that is not live (its own editor, or an owner). Its item, source and any uploaded
 * image stay (items are kept forever, D5); its queued jobs are cancelled; an edition_groups row that only
 * existed for it (no lead, no items, no other stories) goes too.
 */
export async function removeManualStory(user: SessionUser, id: number): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  try {
    return await db.transaction(async (tx) => {
      const { story, edition } = await lockManual(tx, id);
      if (story.createdBy !== user.id && !roleAtLeast(user.role, "owner")) throw new Refused("Only the editor who added it, or an owner, can remove this story.");
      const now = new Date();
      await tx.update(workerJobs).set({ status: "failed", error: `cancelled: story removed by ${bylineOf(user)}`, lockedBy: null, lockedUntil: null, finishedAt: now, updatedAt: now })
        .where(and(inArray(workerJobs.kind, [...storyJobKinds]), inArray(workerJobs.status, ["queued", "running"]), sql`${workerJobs.payload}->>'story_id' = ${String(id)}`));
      try {
        await tx.delete(stories).where(eq(stories.id, id));
      } catch (e) {
        if (pgError(e).code === "23503") {
          throw new Refused("Readers have already saved, read or reported this story, so it stays; add a correction instead.");
        }
        throw e;
      }
      await dropEmptyGroupRow(tx, edition.id, story.groupId);
      const title = story.titleEn || story.titleUr;
      await writeAudit(tx, user.id, "manual_story.remove", `story:${id}`, { title, edition: `${edition.date} ${edition.slot}`, created_by: story.createdBy });
      return { ok: true as const, title };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
}

/** An edition_groups row ensureEditionGroups added for manual stories only (no lead, no items), once its section has no stories left. */
async function dropEmptyGroupRow(tx: Tx, editionId: number, groupId: number): Promise<void> {
  const eg = schema.editionGroups;
  await tx.delete(eg).where(and(
    eq(eg.editionId, editionId), eq(eg.groupId, groupId), eq(eg.leadEn, ""), eq(eg.leadUr, ""), eq(eg.itemCount, 0),
    sql`not exists (select 1 from ${stories} where ${stories.editionId} = ${editionId} and ${stories.groupId} = ${groupId})`,
  ));
}

// ---- jobs: retry and cancel (the jobs, translations and story pages) ------------------------------

/** Transient reasons a blocked translation may be tried again for (never a paywall or robots.txt). */
export const RETRYABLE_BLOCKS = ["unreachable", "needs_germany", "no_text"] as const;

/**
 * Queue a job again: one that failed for good, or a translation blocked for a transient reason (the site
 * was down, or needed the Germany route). Never a paywall or a robots.txt disallow: those are final. A
 * story job is retried only while its story is not live (a live story is never changed).
 */
export async function retryJob(user: SessionUser, id: number): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  try {
    return await db.transaction(async (tx) => {
      const [job] = await tx.select().from(workerJobs).where(eq(workerJobs.id, id)).for("update");
      if (!job) throw new Refused("That job no longer exists.");
      const storyId = Number((job.payload as { story_id?: unknown }).story_id);
      if (job.kind !== "translate_article" && Number.isInteger(storyId)) {
        const [s] = await tx.select({
          deskAt: stories.deskAt, status: editions.status, imageId: stories.imageId,
          titleEn: stories.titleEn, summaryEn: stories.summaryEn, titleUr: stories.titleUr, summaryUr: stories.summaryUr,
        }).from(stories).innerJoin(editions, eq(editions.id, stories.editionId)).where(eq(stories.id, storyId));
        if (!s) throw new Refused("Its story was removed; nothing to retry.");
        if (s.deskAt || s.status === "published") throw new Refused("Its story is live and can no longer change; nothing to retry.");
        // Nothing left to do: retrying would only hold the story back while the job sits in the queue.
        const lang = (job.payload as { lang?: unknown }).lang;
        if (job.kind === "fill_language" && (lang === "en" ? s.titleEn && s.summaryEn : s.titleUr && s.summaryUr)) {
          throw new Refused(`The ${lang === "en" ? "English" : "Urdu"} text is written now; there is nothing for the worker to fill.`);
        }
        if (job.kind === "story_image" && s.imageId) throw new Refused("The story has an image now; there is nothing for the worker to fetch.");
      }
      if (job.status !== "failed" && job.status !== "blocked") throw new Refused(`The job is ${job.status}; only failed (or transiently blocked) jobs can be retried.`);
      let blockedReason: string | null = null, rowBlocked = false;
      if (job.kind === "translate_article") {
        const itemId = Number((job.payload as { item_id?: unknown }).item_id);
        const [t] = await tx.select({ status: articleTranslations.status, blockedReason: articleTranslations.blockedReason }).from(articleTranslations)
          .where(and(eq(articleTranslations.itemId, itemId), eq(articleTranslations.lang, "ur")));
        if (t?.status === "done") throw new Refused("Readers already have this translation.");
        blockedReason = t?.blockedReason ?? null;
        rowBlocked = t?.status === "blocked";
      }
      // A block is final whichever row carries it (the job's or the translation's), unless its reason was transient.
      if (job.status === "blocked" || rowBlocked) {
        if (job.kind !== "translate_article" || !blockedReason || !(RETRYABLE_BLOCKS as readonly string[]).includes(blockedReason)) {
          throw new Refused(`Blocked jobs are final${blockedReason ? ` (${blockedReason.replace(/_/g, " ")})` : ""}: the article cannot be had legitimately, so it is never tried harder.`);
        }
      }
      const now = new Date();
      // The retry is this editor's request: a reader's daily translation allowance (lib/translations.ts
      // dailyUsage counts their jobs queued again today) is never spent by an editor's decision.
      await tx.update(workerJobs).set({
        status: "queued", attempts: 0, runAfter: now, lockedBy: null, lockedUntil: null, result: null, error: null, startedAt: null, finishedAt: null, updatedAt: now,
        requestedBy: user.id,
      }).where(eq(workerJobs.id, id));
      if (job.kind === "translate_article") {
        const itemId = Number((job.payload as { item_id?: unknown }).item_id);
        await tx.update(articleTranslations).set({ status: "queued", error: null, blockedReason: null, jobId: id, finishedAt: null, updatedAt: now })
          .where(and(eq(articleTranslations.itemId, itemId), eq(articleTranslations.lang, "ur"), ne(articleTranslations.status, "done")));
      }
      await writeAudit(tx, user.id, "job.retry", `job:${id}`, { kind: job.kind, was: job.status, ...(blockedReason ? { blocked_reason: blockedReason } : {}) });
      return { ok: true as const, note: `Job #${id} (${job.kind}) is queued again with fresh attempts.` };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
}

/** Cancel a queued job (not a running one: the worker holds its lease). Its translation or desk story is told. */
export async function cancelJob(user: SessionUser, id: number): Promise<{ ok: true; note: string; live: boolean } | { ok: false; error: string }> {
  try {
    return await db.transaction(async (tx) => {
      const [job] = await tx.select().from(workerJobs).where(eq(workerJobs.id, id)).for("update");
      if (!job) throw new Refused("That job no longer exists.");
      if (job.status !== "queued") throw new Refused(`Only a queued job can be cancelled; this one is ${job.status}.`);
      const now = new Date();
      const error = `cancelled by ${bylineOf(user)}`;
      await tx.update(workerJobs).set({ status: "failed", error, finishedAt: now, updatedAt: now }).where(eq(workerJobs.id, id));
      let live = false;
      if (job.kind === "translate_article") {
        const itemId = Number((job.payload as { item_id?: unknown }).item_id);
        await tx.update(articleTranslations).set({ status: "failed", error, finishedAt: now, updatedAt: now })
          .where(and(eq(articleTranslations.itemId, itemId), eq(articleTranslations.lang, "ur"), ne(articleTranslations.status, "done")));
      } else {
        const storyId = Number((job.payload as { story_id?: unknown }).story_id);
        // A cancelled image no longer holds a desk story back (a missing language still does).
        if (Number.isInteger(storyId) && storyId > 0) live = await goLiveIfReady(tx, storyId);
      }
      await writeAudit(tx, user.id, "job.cancel", `job:${id}`, { kind: job.kind });
      return { ok: true as const, note: `Job #${id} cancelled.${live ? " Its desk story is now live." : ""}`, live };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
}
