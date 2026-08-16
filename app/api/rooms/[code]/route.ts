import { NextRequest, NextResponse } from "next/server";
import { hasSupabase } from "@/lib/supabase";
import { getMap } from "@/lib/maps";
import { getRoom, publicRoom, updateRoomSettings } from "@/lib/rooms";
import { isRoomOwner } from "@/lib/roomOwner";
import { parseRaceSettings } from "@/lib/roomRules";

function conflict(room: NonNullable<Awaited<ReturnType<typeof getRoom>>>): NextResponse {
  return NextResponse.json(
    { error: "room changed", room: publicRoom(room), serverNow: Date.now() },
    { status: 409 },
  );
}

/** GET /api/rooms/[code] - canonical room state for cold loads and invalidations. */
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
  return NextResponse.json(
    { room: publicRoom(room), serverNow: Date.now() },
    { headers: { "cache-control": "no-store" } },
  );
}

/** PATCH /api/rooms/[code] - capability-protected, CAS settings update. */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await ctx.params;
  if (!hasSupabase()) {
    return NextResponse.json({ error: "multiplayer requires Supabase" }, { status: 503 });
  }

  const room = await getRoom(code);
  if (!room) return NextResponse.json({ error: "room not found" }, { status: 404 });
  if (!isRoomOwner(req, code, room.ownerTokenHash)) {
    return NextResponse.json({ error: "only the room owner can change settings" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { settings?: unknown; expectedVersion?: unknown }
    | null;
  const settings = parseRaceSettings(body?.settings);
  if (!settings || typeof body?.expectedVersion !== "string") {
    return NextResponse.json({ error: "invalid room settings or version" }, { status: 400 });
  }
  if (body.expectedVersion !== room.version) return conflict(room);
  if (settings.trackId !== "random" && !getMap(settings.trackId)) {
    return NextResponse.json({ error: "map not found" }, { status: 400 });
  }

  const updated = await updateRoomSettings(room, settings);
  if (!updated) {
    const current = await getRoom(code);
    return current ? conflict(current) : NextResponse.json({ error: "room not found" }, { status: 404 });
  }
  return NextResponse.json({ room: publicRoom(updated), serverNow: Date.now() });
}
