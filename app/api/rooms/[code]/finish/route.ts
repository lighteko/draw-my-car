import { NextRequest, NextResponse } from "next/server";
import { finishRoomRace, getRoom, publicRoom } from "@/lib/rooms";
import { isRoomOwner } from "@/lib/roomOwner";
import { isPlausibleLap, recordLapTimes } from "@/lib/leaderboard";
import { getUsernames } from "@/lib/players";

/**
 * POST /api/rooms/[code]/finish — close out a race whose last car has crossed the line.
 *
 * Without this the room sits at `racing` until the owner presses "새 레이스 준비", so anyone
 * opening the room link in between was thrown into a race that had already ended.
 *
 * Deliberately idempotent: the owner may fire this from more than one tab, and the finishing
 * condition can be reached twice as late progress arrives. A repeat call for a race that is
 * already closed is a success, not a conflict — only a call naming a *different* race is
 * rejected, since that one is stale and must not end the race now running.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await ctx.params;
  const room = await getRoom(code);
  if (!room) return NextResponse.json({ error: "room not found" }, { status: 404 });
  if (!isRoomOwner(req, code, room.ownerTokenHash)) {
    return NextResponse.json({ error: "only the room owner can end the race" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { raceId?: unknown; results?: unknown }
    | null;
  if (typeof body?.raceId !== "string") {
    return NextResponse.json({ error: "raceId required" }, { status: 400 });
  }
  if (room.race?.raceId !== body.raceId) {
    return NextResponse.json({ error: "stale race", room: publicRoom(room) }, { status: 409 });
  }
  if (room.status !== "racing") {
    return NextResponse.json({ room: publicRoom(room), serverNow: Date.now() });
  }

  // Lap times ride in on the close-out because this is the one call the room already trusts:
  // owner-gated, named to a specific race, and made exactly when the race is over. Entries are
  // still checked against the grid — the owner reports for everyone, so nothing stops a
  // doctored payload from naming a device that never raced.
  const admitted = new Set(room.race.grid.map((slot) => slot.deviceId));
  const claimed = Array.isArray(body.results) ? body.results : [];
  const laps = claimed
    .filter((entry): entry is { deviceId: string; lapMs: number } => {
      if (typeof entry !== "object" || entry === null) return false;
      const { deviceId, lapMs } = entry as { deviceId?: unknown; lapMs?: unknown };
      return typeof deviceId === "string" && admitted.has(deviceId) && isPlausibleLap(lapMs);
    })
    .slice(0, admitted.size);

  if (laps.length > 0) {
    // Names come from the players table, never from the payload: the board is public, and the
    // owner should not get to choose what everyone else is called on it.
    const names = await getUsernames(laps.map((entry) => entry.deviceId));
    await recordLapTimes(
      laps.map((entry) => ({
        deviceId: entry.deviceId,
        username: names.get(entry.deviceId) ?? "이름 없는 주자",
        trackId: room.race!.trackId,
        lapMs: entry.lapMs,
      })),
    ).catch(() => {
      // A board that missed a lap is not a reason to leave the race open.
    });
  }

  const updated = await finishRoomRace(room, body.raceId);
  // Lost the CAS: someone else closed the same race, which is the outcome we wanted anyway.
  const current = updated ?? (await getRoom(code));
  return NextResponse.json({
    ...(current ? { room: publicRoom(current) } : {}),
    serverNow: Date.now(),
  });
}
