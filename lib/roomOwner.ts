import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

const COOKIE_PREFIX = "dmc_room_owner_";

function cookieName(code: string): string {
  return `${COOKIE_PREFIX}${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

export function createOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOwnerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function setOwnerCookie(response: NextResponse, code: string, token: string): void {
  response.cookies.set(cookieName(code), token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
}

export function isRoomOwner(
  request: NextRequest,
  code: string,
  expectedHash: string | null,
): boolean {
  if (!expectedHash) return false;
  const token = request.cookies.get(cookieName(code))?.value;
  if (!token) return false;
  const actual = Buffer.from(hashOwnerToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
