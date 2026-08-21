import { NextRequest, NextResponse } from "next/server";
import { hasSupabase } from "@/lib/supabase";
import { listLapRecords } from "@/lib/leaderboard";

/** GET /api/leaderboard?trackId=… — every player's best lap, fastest first. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!hasSupabase()) return NextResponse.json({ records: [] });
  const trackId = req.nextUrl.searchParams.get("trackId")?.trim() || undefined;
  const records = await listLapRecords(trackId);
  return NextResponse.json({ records }, { headers: { "cache-control": "no-store" } });
}
