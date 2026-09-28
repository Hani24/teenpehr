import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { imageAttrs, storyImage } from "@/lib/media";
import { getGlossaryMap, type StoryFull } from "@/lib/queries";
import type { Locale } from "@/lib/urdu";
import { StoryImageView, type StoryImageData, type StoryImageVariant } from "./story-image-view";

/*
 * A story's publisher image (decisions I1–I6, D6 in docs/PLAN.md): the image of an item or post the
 * story cites, or nothing (no image, or an editor hid it: lib/media.ts storyImage). This part runs on the
 * server and settles what the reader sees: the alt text (the publisher's own, else "Image from <outlet>"),
 * the credit "Image: <outlet>" linking to the cited article, and the frame's shape. Whether the device
 * loads it at all, and "tap to show" for sensitive images, is components/story-image-view.tsx.
 *
 * Variants: "lead" (must-read cards: large, above the headline; below it in Wazeh), "thumb" (other cards:
 * a small picture at the inline end), "hero" (the story page, under the headline), "print" (the print page).
 */

/** Frame shapes (width / height): cards use one shape each, the story page and print keep the photo's own within bounds. */
const RATIOS: Record<StoryImageVariant, [min: number, max: number]> = {
  lead: [16 / 9, 16 / 9],
  thumb: [1, 1],
  hero: [4 / 3, 2.4],
  print: [1, 2.4],
};

const ARABIC_SCRIPT = /[؀-ۿ]/;
const scriptLang = (s: string): "en" | "ur" => (ARABIC_SCRIPT.test(s) ? "ur" : "en");

/** An http(s) URL, or null: item and post URLs come from feeds and are untrusted. */
function httpHref(u: string | null | undefined): string | null {
  try {
    const url = new URL(String(u ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type StoryWithImage = Pick<StoryFull, "image" | "imageHiddenAt" | "sources" | "posts">;

/** Everything the view needs, or null when the story shows no image. */
export async function storyImageData(story: StoryWithImage, locale: Locale, variant: StoryImageVariant): Promise<StoryImageData | null> {
  const img = storyImage(story);
  // I1/I3: only an image of an item or post this story still cites, and only with its credit linking there
  // (storyImage gives no creditUrl when the owner is not among the story's sources or posts).
  const creditUrl = httpHref(img?.creditUrl);
  if (!img || !creditUrl) return null;
  const [t, labels] = await Promise.all([getTranslations({ locale, namespace: "images" }), locale === "ur" ? getGlossaryMap() : Promise.resolve(null)]);
  const outlet = labels?.get(img.credit.toLowerCase()) ?? img.credit;
  const { src, srcSet, width, height } = imageAttrs(img);
  const [min, max] = RATIOS[variant];
  const natural = img.width / img.height;
  // The publisher's alt is in the publisher's language (the cited item's); ours is in the page's.
  const altLang = img.alt ? (img.itemLang?.toLowerCase().startsWith("ur") ? "ur" : "en") : locale;
  return {
    src, srcSet, width, height,
    ratio: Math.min(max, Math.max(min, Number.isFinite(natural) && natural > 0 ? natural : min)),
    color: /^#[0-9a-f]{6}$/i.test(img.color) ? img.color : "#888888",
    alt: img.alt ?? t("altFallback", { outlet }),
    altLang: altLang === locale ? undefined : altLang,
    outlet,
    outletLang: scriptLang(outlet),
    creditUrl,
    graphic: img.graphic,
  };
}

/** The server honours a Save-Data: on request header too (as navigator.connection.saveData on the device). */
async function saveDataHeader(): Promise<boolean> {
  return (await headers()).get("save-data")?.trim().toLowerCase() === "on";
}

export async function StoryImage({ story, locale, variant, priority = false }:
  { story: StoryWithImage; locale: Locale; variant: StoryImageVariant; priority?: boolean }) {
  const data = await storyImageData(story, locale, variant);
  if (!data) return null;
  return <StoryImageView data={data} variant={variant} priority={priority} saveDataHint={await saveDataHeader()} />;
}
