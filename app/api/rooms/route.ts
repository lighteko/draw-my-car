import { NextRequest, NextResponse } from "next/server";
import { hasSupabase } from "@/lib/supabase";
import { createRoom, publicRoom } from "@/lib/rooms";
import { upsertPlayer } from "@/lib/players";
import { setOwnerCookie } from "@/lib/roomOwner";

/** POST /api/rooms — create a room owned by the requesting device. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const deviceId = req.headers.get("x-device-id");
  if (!deviceId) return NextResponse.json({ error: "missing device id" }, { status: 400 });
  if (!hasSupabase()) {
    return NextResponse.json({ error: "multiplayer requires Supabase" }, { status: 503 });
  }
  await upsertPlayer(deviceId);
  const { room, ownerToken } = await createRoom(deviceId);
  const response = NextResponse.json({ room: publicRoom(room) }, { status: 201 });
  setOwnerCookie(response, room.code, ownerToken);
  return response;
}
