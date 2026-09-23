import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const COOKIE = "tp_admin";
const TTL_SECONDS = 30 * 86_400;

function secret(): string {
  const s = process.env.ADMIN_PASSWORD ?? "";
  if (s.length < 8) throw new Error("ADMIN_PASSWORD is not set (8+ characters); see .env.example");
  return s;
}
function sign(exp: number): string {
  return createHmac("sha256", secret()).update(`tp_admin:${exp}`).digest("base64url");
}
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function makeToken(now = Date.now()): string {
  const exp = Math.floor(now / 1000) + TTL_SECONDS;
  return `${exp}.${sign(exp)}`;
}
export function verifyToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [expS, sig] = token.split(".");
  const exp = Number(expS);
  if (!Number.isFinite(exp) || !sig || exp < now / 1000) return false;
  return safeEqual(sig, sign(exp));
}
export function checkPassword(input: string): boolean {
  return input.length > 0 && safeEqual(input, secret());
}

export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  return verifyToken(jar.get(COOKIE)?.value);
}
/** Call first in every admin page and action. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect("/admin/login");
}
export async function setSession(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, makeToken(), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/admin", maxAge: TTL_SECONDS });
}
export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/admin", maxAge: 0 });
}
