import "server-only";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { isMediaFileName } from "./media";

/*
 * Image files on disk (see lib/media.ts for names and limits). Content-addressed: MEDIA_DIR/<sha256>-<w>.webp,
 * written once through a temporary file and a rename, never changed afterwards. Only names matching
 * MEDIA_FILE_RE are ever joined to the directory, so no request can reach another path. The directory is
 * outside the project at run time, hence the turbopackIgnore comments (no build-time file tracing).
 */

let announced = false;
/**
 * Directory for image files. Like EDITION_SNAPSHOT_DIR (lib/admin/publish.ts), never derived from
 * process.cwd(): the standalone server chdirs into .next/standalone, which every `next build` wipes.
 * MEDIA_DIR must be absolute; unset (or relative, logged and ignored) it is ~/.local/share/teenpehr/media.
 */
export function mediaDir(): string {
  const configured = process.env.MEDIA_DIR?.trim();
  const useEnv = !!configured && isAbsolute(configured);
  const dir = useEnv ? configured : join(homedir(), ".local", "share", "teenpehr", "media");
  if (!announced) {
    announced = true;
    if (configured && !useEnv) console.warn(`MEDIA_DIR "${configured}" is not an absolute path; ignoring it`);
    console.info(`media files: ${dir} (${useEnv ? "MEDIA_DIR" : "default"})`);
  }
  return dir;
}

/** The absolute path of a stored variant, or null for any name that is not `<sha256>-<w>.webp`. */
export function mediaFilePath(file: string): string | null {
  if (!isMediaFileName(file)) return null;
  const dir = normalize(mediaDir()).replace(/[\\/]+$/, ""); // absolute, without a trailing separator
  const path = join(dir, file);
  return path.startsWith(dir + sep) ? path : null;
}

export type WebpInfo = { width: number; height: number; lossless: boolean };

/**
 * What a WebP file claims to be, or null unless it is a well-formed, single-frame WebP with no metadata:
 * RIFF/WEBP header whose size matches the buffer, chunks that tile the file exactly, a VP8, VP8L or VP8X
 * first chunk (with its frame's own header), and no ANIM/ANMF (animation) or EXIF/XMP chunks. Header
 * checks only: the pixels are never decoded on the server, and browsers decode them sandboxed.
 */
export function webpInfo(buf: Uint8Array): WebpInfo | null {
  const n = buf.length;
  if (n < 30 || n > 64 * 1024 * 1024) return null;
  const fourcc = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  const u32 = (o: number) => (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;
  const u24 = (o: number) => buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
  if (fourcc(0) !== "RIFF" || fourcc(8) !== "WEBP" || u32(4) + 8 !== n) return null;

  const chunks: string[] = [];
  let off = 12;
  while (off + 8 <= n) {
    const size = u32(off + 4);
    if (off + 8 + size > n) return null; // a chunk runs past the end
    chunks.push(fourcc(off));
    off += 8 + size + (size & 1); // odd-sized chunks are padded to even
  }
  // The chunks tile the file exactly (a missing pad byte after the last one is tolerated).
  if ((off !== n && off !== n + 1) || !chunks.length) return null;
  if (chunks.some((c) => c === "ANIM" || c === "ANMF" || c === "EXIF" || c === "XMP ")) return null;

  const first = chunks[0];
  if (first === "VP8 ") {
    // Frame tag (3 bytes, bit 0 clear on a key frame), then the start code 9d 01 2a, then 14-bit sizes.
    if ((buf[20] & 1) !== 0 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = (buf[26] | (buf[27] << 8)) & 0x3fff, height = (buf[28] | (buf[29] << 8)) & 0x3fff;
    return width && height ? { width, height, lossless: false } : null;
  }
  if (first === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = u32(21);
    if (bits >>> 29 !== 0) return null; // version must be 0
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, lossless: true };
  }
  if (first === "VP8X") {
    const flags = buf[20];
    if (u32(16) !== 10 || flags & (0x02 | 0x04 | 0x08)) return null; // animation, XMP, EXIF
    const image = chunks.find((c) => c === "VP8 " || c === "VP8L");
    if (!image) return null;
    return { width: u24(24) + 1, height: u24(27) + 1, lossless: image === "VP8L" };
  }
  return null;
}

/**
 * Store one variant under its content-addressed name. A file already there (the same image uploaded for
 * another item or post, or a retry) is kept when it is a valid WebP of the same width; a damaged one is
 * replaced. Returns what is on disk now, which is what the images row must describe.
 */
export async function storeMediaFile(file: string, data: Uint8Array, w: number): Promise<{ bytes: number; w: number; h: number }> {
  const path = mediaFilePath(file);
  if (!path) throw new Error(`bad media file name: ${file}`);
  const existing = await readFile(/*turbopackIgnore: true*/ path).catch(() => null);
  if (existing) {
    const info = webpInfo(existing);
    if (info && info.width === w) return { bytes: existing.length, w: info.width, h: info.height };
  }
  const info = webpInfo(data);
  if (!info || info.width !== w) throw new Error(`not a ${w}px-wide still WebP: ${file}`);
  await mkdir(/*turbopackIgnore: true*/ mediaDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`; // write then rename: never half a file
  try {
    await writeFile(/*turbopackIgnore: true*/ tmp, data, { flag: "wx", mode: 0o644 });
    await rename(/*turbopackIgnore: true*/ tmp, /*turbopackIgnore: true*/ path);
  } catch (e) {
    await unlink(/*turbopackIgnore: true*/ tmp).catch(() => {});
    throw e;
  }
  return { bytes: data.length, w: info.width, h: info.height };
}

/** A stored variant's bytes (self-contained HTML downloads embed them), or null. */
export async function readMediaFile(file: string): Promise<Buffer | null> {
  const path = mediaFilePath(file);
  return path ? readFile(/*turbopackIgnore: true*/ path).catch(() => null) : null;
}

/**
 * A stored variant's size and a way to stream it (opened only when called), or null when the name is bad
 * or the file is missing.
 */
export async function openMediaFile(file: string): Promise<{ size: number; stream: () => ReadableStream<Uint8Array> } | null> {
  const path = mediaFilePath(file);
  if (!path) return null;
  const st = await stat(/*turbopackIgnore: true*/ path).catch(() => null);
  if (!st?.isFile()) return null;
  return { size: st.size, stream: () => Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ path)) as unknown as ReadableStream<Uint8Array> };
}
