import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** The same mark as app/icon.svg (the letter ت), full-bleed: iOS rounds the corners itself. */
export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#f7f3ec" }}>
      <svg width="180" height="180" viewBox="0 0 64 64" fill="#9a2f22">
        <path d="M53 27.5c1.2 12-7.5 20-21.5 20S7.6 40.5 8.4 22.5l3.4 1.6c.4 10 8.3 15.4 19.9 15.4 11.4 0 18-4.6 18.4-12.4z" />
        <path d="M22.5 19.5l4-4.8 4.6 2.9-4 4.8z" />
        <path d="M33.5 19.5l4-4.8 4.6 2.9-4 4.8z" />
      </svg>
    </div>,
    size,
  );
}
