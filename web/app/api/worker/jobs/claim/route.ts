import { NextResponse } from "next/server";
import { checkWorkerAuth, parseBody, noStore } from "@/lib/worker-auth";
import { jobClaimIn } from "@/lib/contracts";
import { claimJob, jobJson } from "@/lib/jobs";

/** POST /api/worker/jobs/claim {kinds, worker_id, lease_s?} → {job} or {job: null} (docs/API.md § Jobs). */
export async function POST(req: Request) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const parsed = await parseBody(req, jobClaimIn);
  if ("error" in parsed) return parsed.error;
  const { kinds, worker_id, lease_s } = parsed.data;
  const job = await claimJob(kinds, worker_id, lease_s);
  return NextResponse.json({ job: job ? jobJson(job) : null }, noStore);
}
