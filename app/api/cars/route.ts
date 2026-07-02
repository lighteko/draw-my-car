import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/db";
import { createCar, listCars } from "@/lib/cars";
import { upsertPlayer } from "@/lib/players";

function deviceId(req: NextRequest): string | null {
  return req.headers.get("x-device-id");
}

/** GET /api/cars — list the requesting device's cars. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const id = deviceId(req);
  if (!id) return NextResponse.json({ error: "missing device id" }, { status: 400 });
  const cars = await listCars(id);
  return NextResponse.json({ cars });
}

/**
 * POST /api/cars — persist a finished generation job as a car owned by this device.
 * Body: { jobId, name? }. The job must be `ready` with a built GLB.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const id = deviceId(req);
  if (!id) return NextResponse.json({ error: "missing device id" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { jobId?: string; name?: string } | null;
  const jobId = body?.jobId?.trim();
  if (!jobId) return NextResponse.json({ error: "missing jobId" }, { status: 400 });

  const job = await getJob(jobId);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (job.status !== "ready" || !job.carUrl) {
    return NextResponse.json({ error: "job is not ready" }, { status: 409 });
  }

  // Ensure the owning player row exists before the FK insert.
  await upsertPlayer(id);

  const car = await createCar({
    ownerDeviceId: id,
    name: body?.name?.trim() || null,
    renderUrl: job.render?.url ?? null,
    glbUrl: job.carUrl,
  });

  return NextResponse.json({ car }, { status: 201 });
}
