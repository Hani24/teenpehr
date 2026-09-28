import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionToken } from "@/lib/auth/session";
import { hashToken, looksLikeToken } from "@/lib/auth/tokens";

/*
 * Admin status messages ride in the redirect's query (?ok= / ?error=, withFlash in ./util.ts), so a
 * link from anyone could carry text of their choosing into the banner that real results use. Each
 * message the server sets is therefore signed for the session that caused it: &fs= is an HMAC over
 * the text, keyed by that session's id (the sha256 of its cookie token, which only the server and
 * that browser can work out). The admin pages show a message only when its signature checks out for
 * the session viewing it, so a crafted link shows nothing, and so does a real one sent to someone else.
 */
export const FLASH_SIG_PARAM = "fs";

async function sessionKey(): Promise<string | null> {
  const raw = await getSessionToken();
  return looksLikeToken(raw) ? hashToken(raw) : null;
}

function mac(key: string, ok: string, error: string): Buffer {
  return createHmac("sha256", key).update(`tabayyun:admin-flash\0${ok}\0${error}`).digest();
}

/** The signature for a message this request's session will see next, or null without a session. */
export async function signFlash(flash: { ok?: string; error?: string }): Promise<string | null> {
  const key = await sessionKey();
  return key ? mac(key, flash.ok ?? "", flash.error ?? "").toString("base64url") : null;
}

/** The message from a page's query, only when it carries this session's signature; else nothing. */
export async function verifiedFlash(ok: string | undefined, error: string | undefined, sig: string | undefined): Promise<{ ok?: string; error?: string }> {
  if ((!ok && !error) || !sig) return {};
  const key = await sessionKey();
  if (!key) return {};
  const want = mac(key, ok ?? "", error ?? "");
  let got: Buffer;
  try { got = Buffer.from(sig, "base64url"); } catch { return {}; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return {};
  return { ok, error };
}
