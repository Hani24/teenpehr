import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Teen Pehr · تین پہر",
    short_name: "Teen Pehr",
    description: "Three editions a day. Every story traced to its sources.",
    start_url: "/en",
    display: "standalone",
    background_color: "#f7f3ec",
    theme_color: "#9a2f22",
    lang: "en",
    dir: "auto",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
