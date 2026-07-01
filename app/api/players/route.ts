import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, hasSupabase } from "@/lib/supabase";

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

  const username = body?.username?.trim() || null;

  if (!hasSupabase()) {
    return NextResponse.json({ deviceId, username });
  }

  const payload: Record<string, unknown> = {
    device_id: deviceId,
    last_seen: new Date().toISOString(),
  };
  if (username) payload.username = username;

  const { data, error } = await getServiceClient()
    .from("players")
    .upsert(payload, { onConflict: "device_id" })
    .select("device_id, username")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deviceId: data.device_id, username: data.username });
}
