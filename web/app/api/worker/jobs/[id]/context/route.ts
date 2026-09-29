import { NextResponse } from "next/server";
import { checkWorkerAuth, noStore } from "@/lib/worker-auth";
import { jobContext } from "@/lib/jobs";
import { badId, jobErrorResponse, jobIdParam } from "../../_http";

/** GET /api/worker/jobs/{id}/context → what the worker needs for the job (docs/API.md § Jobs). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const id = await jobIdParam(ctx);
  if (id === null) return badId();
  try {
    return NextResponse.json(await jobContext(id), noStore);
  } catch (e) {
    return jobErrorResponse(e);
  }
}
