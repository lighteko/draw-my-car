import { NextRequest, NextResponse } from "next/server";
import { hasSupabase } from "@/lib/supabase";
import { getRoom, updateRoom, type RoomStatus } from "@/lib/rooms";
import type { RaceSettings } from "@/lib/roomTypes";

/** GET /api/rooms/[code] — current room + settings (for share-link cold load). */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await ctx.params;
  if (!hasSupabase()) {
    return NextResponse.json({ error: "multiplayer requires Supabase" }, { status: 503 });
  }
  const room = await getRoom(code);
  if (!room) return NextResponse.json({ error: "room not found" }, { status: 404 });
  return NextResponse.json({ room });
}

/** PATCH /api/rooms/[code] — owner-only settings/status updates. */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await ctx.params;
  const deviceId = req.headers.get("x-device-id");
  if (!deviceId) return NextResponse.json({ error: "missing device id" }, { status: 400 });
  if (!hasSupabase()) {
    return NextResponse.json({ error: "multiplayer requires Supabase" }, { status: 503 });
  }

  const room = await getRoom(code);
  if (!room) return NextResponse.json({ error: "room not found" }, { status: 404 });
  if (room.ownerDeviceId !== deviceId) {
    return NextResponse.json({ error: "only the room owner can change settings" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { settings?: RaceSettings; status?: RoomStatus }
    | null;

  const patch: { settings?: RaceSettings; status?: RoomStatus } = {};
  if (body?.settings) patch.settings = body.settings;
  if (body?.status) patch.status = body.status;

  const updated = await updateRoom(code, patch);
  return NextResponse.json({ room: updated });
}
