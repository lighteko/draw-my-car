import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { listMaps } from "@/lib/maps";
import { getRoom, publicRoom, startRoomRace } from "@/lib/rooms";
import { isRoomOwner } from "@/lib/roomOwner";
import { createGrid } from "@/lib/roomRules";
import type { RaceSnapshot } from "@/lib/roomTypes";

const START_LEAD_MS = 6000;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await ctx.params;
  const room = await getRoom(code);
  if (!room) return NextResponse.json({ error: "room not found" }, { status: 404 });
  if (!isRoomOwner(req, code, room.ownerTokenHash)) {
    return NextResponse.json({ error: "only the room owner can start the race" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { expectedVersion?: unknown; playerDeviceIds?: unknown }
    | null;
  if (typeof body?.expectedVersion !== "string" || !Array.isArray(body.playerDeviceIds)) {
    return NextResponse.json({ error: "invalid start request" }, { status: 400 });
  }
  if (body.expectedVersion !== room.version || room.status !== "lobby") {
    return NextResponse.json(
      { error: "room changed", room: publicRoom(room), serverNow: Date.now() },
      { status: 409 },
    );
  }

  let grid;
  try {
    grid = createGrid(body.playerDeviceIds, room.settings.maxPlayers);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid player grid" },
      { status: 400 },
    );
  }
  if (grid.length === 0) {
    return NextResponse.json({ error: "at least one player is required" }, { status: 400 });
  }

  const maps = listMaps();
  const track =
    room.settings.trackId === "random"
      ? maps[Math.floor(Math.random() * maps.length)]
      : maps.find((candidate) => candidate.id === room.settings.trackId);
  if (!track) return NextResponse.json({ error: "map not found" }, { status: 400 });

  const createdAt = Date.now();
  const race: RaceSnapshot = {
    raceId: randomUUID(),
    trackId: track.id,
    laps: room.settings.laps,
    grid,
    createdAt,
    startAt: createdAt + START_LEAD_MS,
  };
  const updated = await startRoomRace(room, race);
  if (!updated) {
    const current = await getRoom(code);
    return NextResponse.json(
      {
        error: "room changed",
        ...(current ? { room: publicRoom(current) } : {}),
        serverNow: Date.now(),
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ room: publicRoom(updated), serverNow: Date.now() });
}
