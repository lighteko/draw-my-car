import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * adminAuth.ts — password gate for the map-lab admin surface.
 *
 * The password lives in ADMIN_PASSWORD (server-only env). A successful login sets
 * an HttpOnly cookie holding a digest *derived from* the password, so sessions are
 * stateless and changing the password invalidates every outstanding session.
 * Fails closed: with no ADMIN_PASSWORD configured, nothing authorizes.
 */

export const ADMIN_SESSION_COOKIE = "dmc_admin";
export const ADMIN_SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

function digest(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

export function isAdminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

export function verifyAdminPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  // Compare digests so lengths always match (timingSafeEqual requires it).
  return timingSafeEqual(digest(`dmc-admin-pw:${password}`), digest(`dmc-admin-pw:${expected}`));
}

/** Cookie value for the current password; null when no password is configured. */
export function adminSessionToken(): string | null {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return null;
  return digest(`dmc-admin-session:${expected}`).toString("hex");
}

/** Whether the incoming request carries a valid admin session cookie. */
export async function isAdminAuthorized(): Promise<boolean> {
  const expected = adminSessionToken();
  if (!expected) return false;
  const store = await cookies();
  const token = store.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
