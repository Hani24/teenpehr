import type { ImageVariant } from "@/db/schema";
import type { StoryFull } from "./queries";
import type { ImagesPref } from "./auth/prefs";

/*
 * Publisher images on stories: file names, upload limits and the <img> attributes for an `images` row.
 * No server imports, so client components can use it too. The files are written and read by
 * lib/media-store.ts (server only), uploaded through POST /api/worker/images and served only to
 * signed-in readers by app/media/[file]/route.ts. Readers never load a publisher's URL (no hotlinking).
 *
 * What a reader sees (decisions I1–I6): the image of an item or post the story cites, with a credit
 * "Image: <outlet>" linking to that cited article; alt is the publisher's own text, else "Image from
 * <outlet>"; a `graphic` image is blurred until tapped (and hidden in Wazeh until tapped); an image an
 * editor hid (stories.image_hidden_at) is never shown. storyImage() below applies the last rule.
 */

/** Widths the worker makes (never upscaled: a narrower original gives one variant at its own width). */
export const IMAGE_WIDTHS = [480, 960] as const;
/** The worker drops originals narrower than this (too small to be a news photo). */
export const IMAGE_MIN_SOURCE_W = 300;
// Upload limits (lib/contracts.ts imageIn); the route also checks each variant's bytes.
export const IMAGE_MAX_VARIANTS = 2;
export const IMAGE_MAX_VARIANT_BYTES = 600 * 1024;
export const IMAGE_MIN_VARIANT_W = 64;
export const IMAGE_MAX_VARIANT_W = 1200;
export const IMAGE_MAX_VARIANT_H = 3000;
/** Sanity bound on the original's reported size (the worker's decompression-bomb guard is tighter). */
export const IMAGE_MAX_SOURCE_PX = 20_000;

/** Where the files are served: /media/<sha256>-<w>.webp (signed-in readers only). */
export const MEDIA_PREFIX = "/media/";
/** A variant's file name: the original's sha256 and the variant's width. Nothing else is ever served. */
export const MEDIA_FILE_RE = /^[0-9a-f]{64}-[1-9][0-9]{1,3}\.webp$/;

export function mediaFileName(sha256: string, w: number): string {
  return `${sha256}-${w}.webp`;
}
export function isMediaFileName(file: string): boolean {
  return MEDIA_FILE_RE.test(file);
}
/** The same-origin URL of a stored variant. */
export function mediaUrl(file: string): string {
  return `${MEDIA_PREFIX}${file}`;
}

/**
 * An image as reader pages and snapshots carry it (lib/queries.ts loads it as `story.image`): every
 * images column but source_url and created_at.
 */
export type StoryImage = NonNullable<StoryFull["image"]>;

/** Variants narrowest first (the jsonb keeps upload order). */
export function sortedVariants(img: Pick<StoryImage, "variants">): ImageVariant[] {
  return [...img.variants].sort((a, b) => a.w - b.w);
}

/**
 * The <img> attributes for an image: `src` is the narrowest variant (what a browser without srcset
 * loads), `srcSet` every variant by width, `width`/`height` the widest variant's (so the box keeps its
 * shape before the file arrives), `sizes` what the caller says the slot is (default the full width).
 * Put `color` behind it as the placeholder.
 */
export function imageAttrs(img: Pick<StoryImage, "variants" | "width" | "height">, sizes = "100vw") {
  const vs = sortedVariants(img);
  const widest = vs[vs.length - 1];
  return {
    src: mediaUrl(vs[0].file),
    srcSet: vs.map((v) => `${mediaUrl(v.file)} ${v.w}w`).join(", "),
    sizes,
    width: widest?.w ?? img.width,
    height: widest?.h ?? img.height,
  };
}

/**
 * Alt text: the publisher's own, else "Image from <outlet>" / "<outlet> کی تصویر". Pass the outlet as the
 * page shows it (Urdu pages: the glossary's Urdu name, as the source chips do). The publisher's alt is in
 * the publisher's language; it is never machine-written or translated.
 */
export function imageAlt(img: Pick<StoryImage, "alt">, locale: "en" | "ur", outlet: string): string {
  if (img.alt) return img.alt;
  return locale === "ur" ? `${outlet} کی تصویر` : `Image from ${outlet}`;
}

/** The credit line under an image: "Image: <outlet>" / "تصویر: <outlet>" (link it to storyImage().creditUrl). */
export function imageCredit(locale: "en" | "ur", outlet: string): string {
  return locale === "ur" ? `تصویر: ${outlet}` : `Image: ${outlet}`;
}

/**
 * A reader's images preference (lib/auth/prefs.ts `images`): auto shows them unless the device asks to
 * save data (navigator.connection.saveData, or the Save-Data: on request header). The boot script
 * (lib/view.ts) sets <html data-images="auto|on|off"> and, when the device asks, data-save-data="on".
 */
export function imagesShown(pref: ImagesPref, saveData: boolean): boolean {
  return pref === "on" || (pref === "auto" && !saveData);
}

type StoryWithImage = Pick<StoryFull, "image" | "imageHiddenAt" | "sources" | "posts">;

/**
 * The image to show with a story, or null (none, or hidden by an editor), with where its credit links:
 * the cited article (or post) the image came from. The outlet name is the item's feed, or the post's author.
 */
export function storyImage(story: StoryWithImage): (StoryImage & { creditUrl: string | null; itemLang: string | null }) | null {
  const img = story.image;
  if (!img || story.imageHiddenAt || !img.variants?.length) return null;
  if (img.itemId != null) {
    const src = story.sources.find((s) => s.itemId === img.itemId);
    return { ...img, creditUrl: src?.item.url ?? null, itemLang: src?.item.lang ?? null };
  }
  const post = story.posts.find((p) => p.postId === img.postId);
  return { ...img, creditUrl: post?.post.url ?? null, itemLang: post?.post.lang ?? null };
}
