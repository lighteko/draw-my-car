import { NextRequest, NextResponse } from "next/server";
import { getCar } from "@/lib/cars";

/** GET /api/cars/[id] — resolve a single car (used by the driving scene). */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const car = await getCar(id);
  if (!car) return NextResponse.json({ error: "car not found" }, { status: 404 });
  return NextResponse.json({ car });
}
