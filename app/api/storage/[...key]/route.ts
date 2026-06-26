import { NextRequest, NextResponse } from "next/server";
import { contentTypeForKey, readObject } from "@/lib/storage";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ key: string[] }> },
): Promise<NextResponse> {
  const { key } = await ctx.params;
  const objectKey = key.join("/");

  try {
    const bytes = await readObject(objectKey);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new NextResponse(body, {
      headers: {
        "content-type": contentTypeForKey(objectKey),
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "object not found" }, { status: 404 });
  }
}
