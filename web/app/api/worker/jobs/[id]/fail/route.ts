import { NextResponse } from "next/server";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { jobFailIn } from "@/lib/contracts";
import { failJob } from "@/lib/jobs";
import { badId, jobErrorResponse, jobIdParam } from "../../_http";

/** POST /api/worker/jobs/{id}/fail {worker_id?, error, retry, blocked?, reason?, retry_after_s?} → {ok, status, retry_at?} (docs/API.md § Jobs). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const id = await jobIdParam(ctx);
  if (id === null) return badId();
  const parsed = await parseBody(req, jobFailIn, { maxBytes: 64_000 });
  if ("error" in parsed) return parsed.error;
  try {
    const r = await failJob(id, parsed.data.worker_id, parsed.data);
    return NextResponse.json({ ok: true, ...r }, noStore);
  } catch (e) {
    return jobErrorResponse(e);
  }
}
