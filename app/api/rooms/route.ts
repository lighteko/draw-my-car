import { NextRequest, NextResponse } from "next/server";
import { hasSupabase } from "@/lib/supabase";
import { createRoom } from "@/lib/rooms";
import { upsertPlayer } from "@/lib/players";

/** POST /api/rooms — create a room owned by the requesting device. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const deviceId = req.headers.get("x-device-id");
  if (!deviceId) return NextResponse.json({ error: "missing device id" }, { status: 400 });
  if (!hasSupabase()) {
    return NextResponse.json({ error: "multiplayer requires Supabase" }, { status: 503 });
  }
  await upsertPlayer(deviceId);
  const room = await createRoom(deviceId);
  return NextResponse.json({ room }, { status: 201 });
}
