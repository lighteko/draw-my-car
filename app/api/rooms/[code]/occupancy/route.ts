import { NextRequest, NextResponse } from "next/server";
import { getRoom, reportRoomOccupancy } from "@/lib/rooms";
import { isRoomOwner } from "@/lib/roomOwner";

/** Upper bound on a reported roster, so a bad actor cannot advertise a room as busy. */
const MAX_REPORTED_PLAYERS = 64;

/**
 * POST /api/rooms/[code]/occupancy — the host tells the server how many people it can see.
 *
 * Only the host may report, for two reasons: the owner cookie makes the number attributable,
 * and a single writer means these timer-driven updates cannot race each other the way
 * one-report-per-player would.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await ctx.params;
  const room = await getRoom(code);
  if (!room) return NextResponse.json({ error: "방을 찾을 수 없습니다" }, { status: 404 });
  if (!isRoomOwner(req, code, room.ownerTokenHash)) {
    return NextResponse.json({ error: "방장만 보고할 수 있습니다" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { players?: unknown } | null;
  if (!Number.isInteger(body?.players)) {
    return NextResponse.json({ error: "잘못된 인원 수입니다" }, { status: 400 });
  }
  const players = Math.max(0, Math.min(MAX_REPORTED_PLAYERS, body!.players as number));
  await reportRoomOccupancy(code, players);
  return NextResponse.json({ ok: true });
}
