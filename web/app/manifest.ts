import type { MetadataRoute } from "next";
import { paletteBg, SYSTEM_LIGHT } from "@/lib/view";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tabayyun · تبیُّن",
    short_name: "Tabayyun",
    description: "Verify before you believe. Three editions a day, in English and Urdu, every story traced to its sources.",
    start_url: "/en",
    display: "standalone",
    // The "system" palette's day paper (lib/view.ts); once a page loads, its theme-color meta follows
    // the reader's palette (components/theme-controls.tsx), so the splash and bar start on the same paper.
    background_color: paletteBg(SYSTEM_LIGHT),
    theme_color: paletteBg(SYSTEM_LIGHT),
    lang: "en",
    dir: "auto",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
