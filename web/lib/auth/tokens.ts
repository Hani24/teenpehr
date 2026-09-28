import "server-only";
import { createHash, randomBytes } from "node:crypto";

/** A fresh secret for a cookie, invite link or feed URL: 32 random bytes, base64url (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database stores instead of a token: sha256, hex. A leaked table cannot be replayed. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Cheap shape check before any lookup, so junk never reaches the database. */
export function looksLikeToken(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(raw);
}
