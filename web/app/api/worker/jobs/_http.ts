import "server-only";
import { NextResponse } from "next/server";
import { JobError } from "@/lib/jobs";

/** The {id} route parameter as a positive integer, or null. */
export async function jobIdParam(ctx: { params: Promise<{ id: string }> }): Promise<number | null> {
  const raw = (await ctx.params).id;
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= 2_147_483_647 ? id : null;
}

export const badId = () => NextResponse.json({ error: "bad job id" }, { status: 400 });

/** A JobError as its HTTP answer; anything else is rethrown (a 500). */
export function jobErrorResponse(e: unknown): NextResponse {
  if (e instanceof JobError) return NextResponse.json({ error: e.message, ...(e.issues ? { issues: e.issues } : {}) }, { status: e.code, headers: { "Cache-Control": "no-store" } });
  throw e;
}
