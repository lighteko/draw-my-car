/**
 * roomMessageAuth.ts — proof of who sent a Realtime message.
 *
 * The Realtime channels for a room are public: anyone holding the publishable key can join
 * `room:{code}` and broadcast a payload claiming any `deviceId`. Nothing in the payload was
 * ever attributable, so a spectator could forge another player's progress or standings.
 *
 * The fix is a server-issued credential: the server HMACs (deviceId, roomCode, validity
 * window) with a secret that never leaves the server, the client attaches that credential to
 * everything it broadcasts, and receivers only dispatch a message whose credential is valid
 * *and* names the same device the message claims to come from. Browsers cannot check an HMAC
 * without the secret, so they ask the server once per sender (see the /verify route) and cache
 * the answer for the session — verification must never sit on the per-frame telemetry path.
 *
 * This module is imported by both the API routes and the browser. Only the routes call the
 * signing/verifying helpers; the secret readers are never reachable from client code.
 */

/** Six hours: long enough to outlive a session, short enough that a leaked token dies. */
export const CREDENTIAL_TTL_MS = 6 * 60 * 60 * 1000;

/** Cap on one /verify batch, so a hostile peer cannot turn the endpoint into a work amplifier. */
export const MAX_VERIFY_BATCH = 32;

/** Payload key carrying the credential alongside a RoomMessage. */
export const CREDENTIAL_FIELD = "__cred";

export interface RoomCredential {
  deviceId: string;
  roomCode: string;
  issuedAt: number;
  expiresAt: number;
  /** HMAC-SHA256 of the canonical string, base64url. */
  signature: string;
}

/**
 * The signed string. Device ids are self-minted and can contain any character, so fields are
 * length-prefixed rather than merely delimited: without that, ("a\nb", "c") and ("a", "b\nc")
 * would MAC to the same value and a token could be reinterpreted as one for another room.
 */
export function canonicalCredentialString(
  credential: Omit<RoomCredential, "signature">,
): string {
  return [
    "dmc-room-token.v1",
    credential.deviceId,
    normalizeRoomCode(credential.roomCode),
    String(credential.issuedAt),
    String(credential.expiresAt),
  ]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}

/** Room codes are case-insensitive elsewhere in the app; sign only the normalized form. */
export function normalizeRoomCode(code: string): string {
  return code.trim().toLowerCase();
}

// --- secret (server only) ---

/**
 * The signing secret, or null when none is configured.
 *
 * There is deliberately no random fallback. A per-process random value looks like a safe
 * "fail closed" default, but route handlers do not share a module instance — /token and
 * /verify each minted their own key, so every genuine credential failed to verify and the
 * receiver dropped ALL inbound traffic. That is not a degraded mode, it is a dead game.
 * With no secret configured we return null and the callers disable enforcement instead,
 * which loses sender attribution but keeps rooms playable.
 */
export function getRoomMessageSecret(): string | null {
  const configured =
    process.env.ROOM_MESSAGE_SECRET ??
    process.env.AUTH_SECRET_KEY ??
    // Any stable server-only secret works as key material and every deployment that has
    // multiplayer at all has this one.
    process.env.SUPABASE_SECRET_KEY;
  return configured && configured.length > 0 ? configured : null;
}

/** Whether message signing is switched on for this deployment. */
export function isRoomMessageAuthConfigured(): boolean {
  return getRoomMessageSecret() !== null;
}

// --- signing / verifying (server only) ---

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Web Crypto rather than node:crypto so this module stays importable from the browser bundle
// even though only the routes ever reach these functions.
async function hmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(canonical: string): Promise<string> {
  const secret = getRoomMessageSecret();
  if (!secret) throw new Error("room message signing is not configured");
  const key = await hmacKey(secret);
  const mac = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  return base64url(new Uint8Array(mac));
}

/** Mint a credential proving this device asked the server for one, for this room. */
export async function issueRoomCredential(
  deviceId: string,
  roomCode: string,
  now: number = Date.now(),
): Promise<RoomCredential> {
  const unsigned = {
    deviceId,
    roomCode: normalizeRoomCode(roomCode),
    issuedAt: now,
    expiresAt: now + CREDENTIAL_TTL_MS,
  };
  return { ...unsigned, signature: await sign(canonicalCredentialString(unsigned)) };
}

/** Compare without leaking, through timing, how much of a forged signature was correct. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A credential is good only for the room it was issued for and only inside its window, so a
 * token harvested from one room cannot be replayed in another.
 */
export async function verifyRoomCredential(
  credential: RoomCredential,
  roomCode: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (normalizeRoomCode(credential.roomCode) !== normalizeRoomCode(roomCode)) return false;
  if (!(credential.issuedAt <= now && now < credential.expiresAt)) return false;
  const expected = await sign(canonicalCredentialString(credential));
  return constantTimeEquals(expected, credential.signature);
}

// --- untrusted input ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Parse a credential off the wire. Shape only — validity is decided by verifyRoomCredential. */
export function parseRoomCredential(value: unknown): RoomCredential | null {
  if (!isRecord(value)) return null;
  if (
    !isBoundedString(value.deviceId, 256) ||
    !isBoundedString(value.roomCode, 64) ||
    !isBoundedString(value.signature, 128) ||
    !Number.isFinite(value.issuedAt) ||
    !Number.isFinite(value.expiresAt) ||
    (value.expiresAt as number) <= (value.issuedAt as number)
  ) {
    return null;
  }
  return {
    deviceId: value.deviceId,
    roomCode: value.roomCode,
    issuedAt: value.issuedAt as number,
    expiresAt: value.expiresAt as number,
    signature: value.signature,
  };
}

// --- message envelope ---

/**
 * The credential rides beside the message rather than inside it: parseRoomMessage rejects
 * unknown keys, so the receiver strips this field before parsing and roomRules stays untouched.
 */
export function withCredential(
  message: object,
  credential: RoomCredential | null,
): Record<string, unknown> {
  if (!credential) return { ...message };
  return { ...message, [CREDENTIAL_FIELD]: credential };
}

export function splitCredential(payload: unknown): {
  message: unknown;
  credential: RoomCredential | null;
} {
  if (!isRecord(payload)) return { message: payload, credential: null };
  const { [CREDENTIAL_FIELD]: raw, ...message } = payload;
  return { message, credential: parseRoomCredential(raw) };
}

/**
 * The identity a payload asserts, or null when it asserts none. A credential authenticates a
 * device, so it can only vouch for a message that claims that same device.
 */
export function claimedSenderDeviceId(message: unknown): string | null {
  if (!isRecord(message)) return null;
  if (typeof message.senderDeviceId === "string") return message.senderDeviceId;
  if (isRecord(message.member) && typeof message.member.deviceId === "string") {
    return message.member.deviceId;
  }
  return null;
}

/**
 * The local half of the check, run on every inbound message including 20-30 Hz telemetry:
 * everything except the HMAC itself, which the cache answers. Shape, room, expiry and the
 * claimed-vs-signed device match are all decided here without touching the network.
 */
export function isCredentialConsistent(
  credential: RoomCredential,
  message: unknown,
  roomCode: string,
  now: number = Date.now(),
): boolean {
  if (normalizeRoomCode(credential.roomCode) !== normalizeRoomCode(roomCode)) return false;
  if (!(credential.issuedAt <= now && now < credential.expiresAt)) return false;
  const claimed = claimedSenderDeviceId(message);
  // A message with no claimed identity (room_changed) still has to come from a member of the
  // room, which the signed credential already establishes.
  return claimed === null || claimed === credential.deviceId;
}

/** Cache key for a decided (deviceId, signature) pair. */
export function credentialCacheKey(credential: RoomCredential): string {
  return `${credential.deviceId} ${credential.signature}`;
}
