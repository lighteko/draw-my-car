import { NextRequest, NextResponse } from "next/server";
import { getRoom } from "@/lib/rooms";
import {
  isRoomMessageAuthConfigured,
  MAX_VERIFY_BATCH,
  parseRoomCredential,
  verifyRoomCredential,
  type RoomCredential,
} from "@/lib/roomMessageAuth";

/**
 * Decides whether peers' credentials are genuine, on behalf of browsers that cannot check an
 * HMAC without the secret. Callers batch and cache per sender, so this runs about once per
 * peer per session rather than once per message.
 *
 * The response says only valid/invalid — it never echoes a signature back or mints one, so
 * this endpoint cannot be used as a signing oracle.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { credentials?: unknown } | null;
  if (!Array.isArray(body?.credentials) || body.credentials.length > MAX_VERIFY_BATCH) {
    return NextResponse.json({ error: "invalid verify request" }, { status: 400 });
  }

  const room = await getRoom(code);
  if (!room) return NextResponse.json({ error: "room not found" }, { status: 404 });
  if (!isRoomMessageAuthConfigured()) return NextResponse.json({ enforced: false, results: [] });

  const parsed = body.credentials.map(parseRoomCredential);
  const results = await Promise.all(
    parsed.map(async (credential: RoomCredential | null) => {
      if (!credential) return { deviceId: "", signature: "", valid: false };
      return {
        deviceId: credential.deviceId,
        signature: credential.signature,
        valid: await verifyRoomCredential(credential, code),
      };
    }),
  );

  return NextResponse.json({ results });
}
