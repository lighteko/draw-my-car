import { NextResponse } from "next/server";
import { hasSupabase } from "@/lib/supabase";
import { listOpenRooms } from "@/lib/rooms";

/**
 * GET /api/rooms/open — rooms a player can walk into, for the room browser.
 *
 * Never cached: a lobby's usefulness is entirely about whether someone is in it right now.
 */
export async function GET(): Promise<NextResponse> {
  if (!hasSupabase()) {
    return NextResponse.json({ error: "멀티플레이는 Supabase 설정이 필요합니다" }, { status: 503 });
  }
  const rooms = await listOpenRooms();
  return NextResponse.json({ rooms }, { headers: { "cache-control": "no-store" } });
}
