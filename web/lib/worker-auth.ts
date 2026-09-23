import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

/** Constant-time bearer check for /api/worker/*. */
export function checkWorkerAuth(req: Request): NextResponse | null {
  const expected = process.env.WORKER_TOKEN ?? "";
  const header = req.headers.get("authorization") ?? "";
  const got = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!expected || expected === "change-me" || got.length === 0) return unauthorized();
  const a = Buffer.from(got), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return unauthorized();
  return null;
}

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** Parse and validate a JSON body; returns a 400 response on failure. */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<{ data: T } | { error: NextResponse }> {
  let json: unknown;
  try {
    const text = await req.text();
    json = text.trim() ? JSON.parse(text) : {};
  } catch { return { error: NextResponse.json({ error: "invalid JSON" }, { status: 400 }) }; }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = (result.error as ZodError).issues.slice(0, 20).map((i) => {
      let value: unknown = json;
      for (const k of i.path) value = value != null && typeof value === "object" ? (value as Record<string | number, unknown>)[k as string | number] : undefined;
      const snippet = typeof value === "string" ? value.slice(0, 160) : value === undefined ? undefined : JSON.stringify(value).slice(0, 160);
      return { path: i.path.join("."), message: i.message, value: snippet };
    });
    return { error: NextResponse.json({ error: "validation failed", issues }, { status: 400 }) };
  }
  return { data: result.data };
}

export const noStore = { headers: { "Cache-Control": "no-store" } } as const;
