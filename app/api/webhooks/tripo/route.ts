import { NextRequest, NextResponse } from "next/server";
import { updateJob } from "@/lib/db";

/**
 * POST /api/webhooks/tripo — Tripo calls this when a task completes.
 *
 * v0: stub. We accept the payload and, if it carries a job id we know, nudge the job
 * forward. No signature verification and no network calls yet.
 *
 * TODO(v1):
 *   - verify the provider signature / shared secret,
 *   - map payload { task_id, status, output.model } to our job,
 *   - storage-copy or presign the GLB, then updateJob(jobId, { status: "ready", carUrl, carId }).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const payload = (await req.json().catch(() => null)) as
    | { jobId?: string; data?: { jobId?: string } }
    | null;

  // TODO(v1): validate provider signature here before trusting the payload.
  const jobId = payload?.jobId ?? payload?.data?.jobId;
  if (jobId) {
    updateJob(jobId, { status: "processing" });
  }

  return NextResponse.json({ received: true });
}
