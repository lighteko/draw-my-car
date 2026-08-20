import { NextRequest, NextResponse } from "next/server";
import { hasSupabase } from "@/lib/supabase";
import { createRoom, findJoinableRoom, publicRoom } from "@/lib/rooms";
import { upsertPlayer } from "@/lib/players";
import { setOwnerCookie } from "@/lib/roomOwner";

/**
 * POST /api/rooms/join — join an already-open lobby if one exists, otherwise create a new
 * one. This is what the garage's PLAY button calls so that two players who both press play at
 * roughly the same time end up together instead of scattered into separate empty rooms.
 *
 * Only a genuinely NEW room gets an owner cookie: reusing createRoom (the same path
 * POST /api/rooms uses) keeps that capability-grant behaviour in one place. A player who joins
 * an existing room must not receive one — they are not its owner.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const deviceId = req.headers.get("x-device-id");
  if (!deviceId) return NextResponse.json({ error: "missing device id" }, { status: 400 });
  if (!hasSupabase()) {
    return NextResponse.json({ error: "multiplayer requires Supabase" }, { status: 503 });
  }
  await upsertPlayer(deviceId);

  const existing = await findJoinableRoom();
  if (existing) {
    return NextResponse.json({ room: publicRoom(existing), created: false }, { status: 200 });
  }

  const { room, ownerToken } = await createRoom(deviceId);
  const response = NextResponse.json({ room: publicRoom(room), created: true }, { status: 201 });
  setOwnerCookie(response, room.code, ownerToken);
  return response;
}
