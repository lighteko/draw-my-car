import { NextRequest, NextResponse } from "next/server";
import { upsertPlayer } from "@/lib/players";

/**
 * POST /api/players — upsert the player identified by their device id.
 *
 * There is no login: the browser mints a device id (see lib/identity.ts) and this route
 * keeps a matching row (username + last_seen). When Supabase is not configured, identity
 * is simply the device id and this is a no-op echo.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as
    | { deviceId?: string; username?: string }
    | null;
  const deviceId = body?.deviceId?.trim();
  if (!deviceId) {
    return NextResponse.json({ error: "missing deviceId" }, { status: 400 });
  }

  try {
    const player = await upsertPlayer(deviceId, body?.username?.trim() || null);
    return NextResponse.json(player);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to upsert player" },
      { status: 500 },
    );
  }
}
