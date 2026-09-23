import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 14, background: "#f7f3ec", padding: 32 }}>
      <div style={{ width: 22, height: 62, background: "#9a2f22", borderRadius: 5 }} />
      <div style={{ width: 22, height: 96, background: "#9a2f22", borderRadius: 5 }} />
      <div style={{ width: 22, height: 48, background: "#9a2f22", borderRadius: 5 }} />
    </div>,
    size,
  );
}
