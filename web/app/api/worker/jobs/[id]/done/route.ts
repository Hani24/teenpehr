import { NextResponse } from "next/server";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { jobDoneIn, TRANSLATION_BODY_MAX } from "@/lib/contracts";
import { finishJob } from "@/lib/jobs";
import { badId, jobErrorResponse, jobIdParam } from "../../_http";

/** POST /api/worker/jobs/{id}/done {worker_id?, result} → {ok, status, applied, note?, already?} (docs/API.md § Jobs). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const id = await jobIdParam(ctx);
  if (id === null) return badId();
  // A full-article translation is the largest result: its body (UTF-8 Urdu, up to 3 bytes a character) and headroom.
  const parsed = await parseBody(req, jobDoneIn, { maxBytes: TRANSLATION_BODY_MAX * 3 + 64_000 });
  if ("error" in parsed) return parsed.error;
  try {
    const r = await finishJob(id, parsed.data.worker_id, parsed.data.result);
    return NextResponse.json({ ok: true, ...r }, noStore);
  } catch (e) {
    return jobErrorResponse(e);
  }
}
