import { beforeAll, describe, expect, it } from "vitest";
import {
  CREDENTIAL_TTL_MS,
  canonicalCredentialString,
  claimedSenderDeviceId,
  credentialCacheKey,
  isCredentialConsistent,
  issueRoomCredential,
  parseRoomCredential,
  splitCredential,
  verifyRoomCredential,
  withCredential,
  type RoomCredential,
} from "./roomMessageAuth";

const NOW = 1_700_000_000_000;

beforeAll(() => {
  process.env.ROOM_MESSAGE_SECRET = "test-secret-value";
});

describe("issueRoomCredential / verifyRoomCredential", () => {
  it("verifies a freshly issued credential inside its window", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", NOW);
    expect(credential.expiresAt - credential.issuedAt).toBe(CREDENTIAL_TTL_MS);
    expect(await verifyRoomCredential(credential, "ABCD", NOW)).toBe(true);
    // Room codes are case-insensitive everywhere else in the app.
    expect(await verifyRoomCredential(credential, "abcd", NOW)).toBe(true);
  });

  it("rejects a credential replayed into a different room", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", NOW);
    expect(await verifyRoomCredential(credential, "WXYZ", NOW)).toBe(false);
  });

  it("rejects a credential outside its validity window", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", NOW);
    expect(await verifyRoomCredential(credential, "ABCD", NOW - 1)).toBe(false);
    expect(await verifyRoomCredential(credential, "ABCD", NOW + CREDENTIAL_TTL_MS)).toBe(false);
  });

  it("rejects a credential whose signed fields were tampered with", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", NOW);
    // The whole point: swapping in another device id must not survive the MAC.
    expect(await verifyRoomCredential({ ...credential, deviceId: "device-b" }, "ABCD", NOW)).toBe(
      false,
    );
    expect(
      await verifyRoomCredential(
        { ...credential, expiresAt: credential.expiresAt + 86_400_000 },
        "ABCD",
        NOW,
      ),
    ).toBe(false);
    expect(await verifyRoomCredential({ ...credential, signature: "nope" }, "ABCD", NOW)).toBe(
      false,
    );
  });

  it("gives two devices different signatures and cache keys", async () => {
    const a = await issueRoomCredential("device-a", "ABCD", NOW);
    const b = await issueRoomCredential("device-b", "ABCD", NOW);
    expect(a.signature).not.toBe(b.signature);
    expect(credentialCacheKey(a)).not.toBe(credentialCacheKey(b));
  });

  it("cannot be confused by field values that merge across the separator", async () => {
    const a = canonicalCredentialString({
      deviceId: "a",
      roomCode: "b\nc",
      issuedAt: NOW,
      expiresAt: NOW + 1,
    });
    expect(a).not.toBe(
      canonicalCredentialString({
        deviceId: "a\nb",
        roomCode: "c",
        issuedAt: NOW,
        expiresAt: NOW + 1,
      }),
    );
    // And the two must therefore not share a signature either.
    const one = await issueRoomCredential("a", "b\nc", NOW);
    const two = await issueRoomCredential("a\nb", "c", NOW);
    expect(one.signature).not.toBe(two.signature);
  });
});

describe("parseRoomCredential", () => {
  it.each([
    null,
    "x",
    [],
    {},
    { deviceId: "a", roomCode: "b", issuedAt: 1, expiresAt: 2 },
    { deviceId: "", roomCode: "b", issuedAt: 1, expiresAt: 2, signature: "s" },
    { deviceId: "a", roomCode: "b", issuedAt: 2, expiresAt: 1, signature: "s" },
    { deviceId: "a", roomCode: "b", issuedAt: "1", expiresAt: 2, signature: "s" },
  ])("rejects malformed input %#", (value) => {
    expect(parseRoomCredential(value)).toBeNull();
  });

  it("accepts a well-formed credential", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", NOW);
    expect(parseRoomCredential(JSON.parse(JSON.stringify(credential)))).toEqual(credential);
  });
});

describe("envelope", () => {
  it("round-trips a message and its credential without disturbing the message", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", NOW);
    const message = { kind: "room_changed", version: "v1" };
    const { message: out, credential: parsed } = splitCredential(
      withCredential(message, credential),
    );
    expect(out).toEqual(message);
    expect(parsed).toEqual(credential);
  });

  it("reports no credential for an unsigned payload", () => {
    expect(splitCredential({ kind: "room_changed", version: "v1" }).credential).toBeNull();
  });

  it("omits the field entirely when there is no credential to attach", () => {
    expect(withCredential({ kind: "room_changed", version: "v1" }, null)).toEqual({
      kind: "room_changed",
      version: "v1",
    });
  });
});

describe("claimedSenderDeviceId", () => {
  it("reads the identity a payload asserts", () => {
    expect(claimedSenderDeviceId({ kind: "progress", senderDeviceId: "d1" })).toBe("d1");
    expect(claimedSenderDeviceId({ kind: "player_state", member: { deviceId: "d2" } })).toBe("d2");
    expect(claimedSenderDeviceId({ kind: "room_changed", version: "v1" })).toBeNull();
    expect(claimedSenderDeviceId(null)).toBeNull();
  });
});

describe("isCredentialConsistent", () => {
  const credential: RoomCredential = {
    deviceId: "device-a",
    roomCode: "abcd",
    issuedAt: NOW,
    expiresAt: NOW + CREDENTIAL_TTL_MS,
    signature: "irrelevant-here",
  };

  it("accepts a message claiming the credential's own device", () => {
    const message = { kind: "transform", senderDeviceId: "device-a", deviceId: "device-a" };
    expect(isCredentialConsistent(credential, message, "ABCD", NOW)).toBe(true);
  });

  it("rejects a message claiming somebody else's device", () => {
    const message = { kind: "progress", senderDeviceId: "device-b", deviceId: "device-b" };
    expect(isCredentialConsistent(credential, message, "ABCD", NOW)).toBe(false);
  });

  it("rejects a stale credential or one from another room", () => {
    const message = { kind: "room_changed", version: "v1" };
    expect(isCredentialConsistent(credential, message, "ABCD", NOW + CREDENTIAL_TTL_MS)).toBe(false);
    expect(isCredentialConsistent(credential, message, "WXYZ", NOW)).toBe(false);
  });

  it("allows an anonymous message kind from any credentialed member", () => {
    expect(isCredentialConsistent(credential, { kind: "room_changed", version: "v1" }, "abcd", NOW)).toBe(
      true,
    );
  });
});
