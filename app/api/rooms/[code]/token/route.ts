import { NextRequest, NextResponse } from "next/server";
import { getRoom } from "@/lib/rooms";
import { isRoomMessageAuthConfigured, issueRoomCredential } from "@/lib/roomMessageAuth";

/**
 * Hands the caller a credential proving its device asked for one, for this room.
 *
 * This is deliberately not an authorization check — device ids are self-minted and anyone can
 * ask for a token. What the token buys is *attribution*: a broadcast can no longer claim a
 * device id other than the one the holder asked for, which is the actual spoofing hole.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await ctx.params;
  const deviceId = req.headers.get("x-device-id")?.trim();
  if (!deviceId || deviceId.length > 256) {
    return NextResponse.json({ error: "device id required" }, { status: 400 });
  }

  // The client generates its own keypair and sends only the public half; the certificate we
  // hand back binds that key to this device and room.
  const body = (await req.json().catch(() => null)) as { publicKeyJwk?: unknown } | null;
  const publicKeyJwk = typeof body?.publicKeyJwk === "string" ? body.publicKeyJwk : null;
  if (!publicKeyJwk || publicKeyJwk.length > 1024) {
    return NextResponse.json({ error: "public key required" }, { status: 400 });
  }

  const room = await getRoom(code);
  if (!room) return NextResponse.json({ error: "room not found" }, { status: 404 });

  // No secret configured: tell the client so it stops requiring signatures it can never get.
  // Enforcing here would drop every inbound message and take the room down with it.
  if (!isRoomMessageAuthConfigured()) {
    return NextResponse.json({ enforced: false });
  }

  return NextResponse.json({ enforced: true, ...(await issueRoomCredential(deviceId, code, publicKeyJwk)) });
}
