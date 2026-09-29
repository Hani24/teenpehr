import { NextResponse } from "next/server";
import { getCurrentUser, roleAtLeast } from "@/lib/auth";
import { processUpload, signForSession, UPLOAD_MAX_BYTES, UPLOAD_TYPES, UploadError } from "@/lib/admin/manual";

/*
 * POST /admin/stories/image: an editor's image for a manual story (D12), multipart field `file`. Up to 8 MB,
 * which is over a Server Action's 1 MB body limit, hence a route handler. Editors and owners only, from this
 * site's own pages only (the session cookie is SameSite=Lax, and Origin / Sec-Fetch-Site are checked too).
 * The image is re-encoded and stripped (lib/admin/manual.ts processUpload: sRGB, no metadata, WebP 480 and
 * 960 px, content-addressed files in MEDIA_DIR) and nothing else is stored yet: the answer carries the
 * variants signed for this session, and the story's create step records the images row against its link's
 * item. Files no story shows are never served to readers (app/media/[file]/route.ts).
 */
const noStore = { "Cache-Control": "private, no-store" };
/** The multipart body: the file plus room for its part headers and boundary. */
const BODY_MAX = UPLOAD_MAX_BYTES + 64 * 1024;

/** The request body, or null once it passes `max` bytes (reading stops there). */
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, headers: noStore });

function sameSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (!origin) return !!site; // a browser sends one or the other
  const hosts = [req.headers.get("x-forwarded-host"), req.headers.get("host")].filter(Boolean).map((h) => h!.split(",")[0].trim().toLowerCase());
  try { return hosts.includes(new URL(origin).host.toLowerCase()); } catch { return false; }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return fail(401, "Sign in again.");
  if (!roleAtLeast(user.role, "editor")) return fail(403, "Editors and owners only.");
  if (!sameSite(req)) return fail(403, "Uploads come from the admin's own pages only.");
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > BODY_MAX) return fail(413, `The image is larger than ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
  // Content-Length can be absent (a chunked body), so the cap is enforced while reading, never after.
  const body = await readCapped(req, BODY_MAX);
  if (!body) return fail(413, `The image is larger than ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "Content-Type": req.headers.get("content-type") ?? "" } }).formData();
  } catch { return fail(400, "Send the image as a file (multipart form)."); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return fail(400, "Choose an image file.");
  if (file.size > UPLOAD_MAX_BYTES) return fail(413, `The image is larger than ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
  if (!(UPLOAD_TYPES as readonly string[]).includes(file.type)) return fail(415, "Use a JPEG, PNG, WebP, AVIF or GIF image (never SVG).");
  try {
    const up = await processUpload(Buffer.from(await file.arrayBuffer()));
    const json = JSON.stringify(up);
    const sig = await signForSession("manual-image", json);
    if (!sig) return fail(401, "Sign in again.");
    const smallest = [...up.variants].sort((a, b) => a.w - b.w)[0];
    return NextResponse.json({ ok: true, json, sig, preview: { file: smallest.file, w: smallest.w, h: smallest.h, width: up.width, height: up.height, color: up.color, variants: up.variants.length } }, { headers: noStore });
  } catch (e) {
    if (e instanceof UploadError) return fail(400, e.message);
    console.error("manual story image:", (e as Error).message);
    return fail(500, "The image could not be processed. Try another file, or use the article's image.");
  }
}
