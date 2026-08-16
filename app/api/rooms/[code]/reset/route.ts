import { NextRequest, NextResponse } from "next/server";
import { getRoom, publicRoom, resetRoomToLobby } from "@/lib/rooms";
import { isRoomOwner } from "@/lib/roomOwner";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await ctx.params;
  const room = await getRoom(code);
  if (!room) return NextResponse.json({ error: "room not found" }, { status: 404 });
  if (!isRoomOwner(req, code, room.ownerTokenHash)) {
    return NextResponse.json({ error: "only the room owner can reset the room" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as
    | { expectedVersion?: unknown; raceId?: unknown }
    | null;
  if (
    typeof body?.expectedVersion !== "string" ||
    typeof body.raceId !== "string" ||
    body.expectedVersion !== room.version ||
    body.raceId !== room.race?.raceId
  ) {
    return NextResponse.json(
      { error: "room changed", room: publicRoom(room), serverNow: Date.now() },
      { status: 409 },
    );
  }
  const updated = await resetRoomToLobby(room);
  if (!updated) return NextResponse.json({ error: "room changed" }, { status: 409 });
  return NextResponse.json({ room: publicRoom(updated), serverNow: Date.now() });
}
