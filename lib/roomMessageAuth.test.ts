import { beforeAll, describe, expect, it } from "vitest";
import {
  CREDENTIAL_TTL_MS,
  MAX_MESSAGE_AGE_MS,
  canonicalMessageString,
  createMessageSigner,
  createReplayGuard,
  createSenderGate,
  importVerifyingKey,
  stableStringify,
  verifyMessageSignature,
  canonicalCredentialString,
  claimedSenderDeviceId,
  credentialCacheKey,
  isCredentialConsistent,
  issueRoomCredential,
  parseRoomCredential,
  replayKey,
  splitCredential,
  verifyRoomCredential,
  withCredential,
  type RoomCredential,
} from "./roomMessageAuth";

const NOW = 1_700_000_000_000;
const KEY = '{"kty":"EC","crv":"P-256","x":"test-x","y":"test-y"}';

beforeAll(() => {
  process.env.ROOM_MESSAGE_SECRET = "test-secret-value";
});

describe("issueRoomCredential / verifyRoomCredential", () => {
  it("verifies a freshly issued credential inside its window", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", KEY, NOW);
    expect(credential.expiresAt - credential.issuedAt).toBe(CREDENTIAL_TTL_MS);
    expect(await verifyRoomCredential(credential, "ABCD", NOW)).toBe(true);
    // Room codes are case-insensitive everywhere else in the app.
    expect(await verifyRoomCredential(credential, "abcd", NOW)).toBe(true);
  });

  it("rejects a credential replayed into a different room", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", KEY, NOW);
    expect(await verifyRoomCredential(credential, "WXYZ", NOW)).toBe(false);
  });

  it("rejects a credential outside its validity window", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", KEY, NOW);
    expect(await verifyRoomCredential(credential, "ABCD", NOW - 1)).toBe(false);
    expect(await verifyRoomCredential(credential, "ABCD", NOW + CREDENTIAL_TTL_MS)).toBe(false);
  });

  it("rejects a credential whose signed fields were tampered with", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", KEY, NOW);
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
    const a = await issueRoomCredential("device-a", "ABCD", KEY, NOW);
    const b = await issueRoomCredential("device-b", "ABCD", KEY, NOW);
    expect(a.signature).not.toBe(b.signature);
    expect(credentialCacheKey(a)).not.toBe(credentialCacheKey(b));
  });

  it("cannot be confused by field values that merge across the separator", async () => {
    const a = canonicalCredentialString({
      deviceId: "a",
      roomCode: "b\nc",
      issuedAt: NOW,
      expiresAt: NOW + 1,
      publicKeyJwk: KEY,
    });
    expect(a).not.toBe(
      canonicalCredentialString({
        deviceId: "a\nb",
        roomCode: "c",
        issuedAt: NOW,
        expiresAt: NOW + 1,
      publicKeyJwk: KEY,
      }),
    );
    // And the two must therefore not share a signature either.
    const one = await issueRoomCredential("a", "b\nc", KEY, NOW);
    const two = await issueRoomCredential("a\nb", "c", KEY, NOW);
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
    const credential = await issueRoomCredential("device-a", "ABCD", KEY, NOW);
    expect(parseRoomCredential(JSON.parse(JSON.stringify(credential)))).toEqual(credential);
  });
});

describe("envelope", () => {
  it("round-trips a message and its credential without disturbing the message", async () => {
    const credential = await issueRoomCredential("device-a", "ABCD", KEY, NOW);
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
    publicKeyJwk: KEY,
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

describe("per-message signatures", () => {
  it("a captured certificate cannot sign a message the holder never sent", async () => {
    // The attack the bearer-token design allowed: certificates are broadcast in the clear,
    // so anyone listening can copy one. Only the private key can produce the signature.
    const victim = await createMessageSigner();
    const attacker = await createMessageSigner();
    if (!victim || !attacker) throw new Error("Web Crypto unavailable");

    const message = { kind: "progress", senderDeviceId: "victim", lap: 3, nextGate: 7 };
    const canonical = canonicalMessageString("abcd", "victim", "control", 1, NOW, message);
    // The attacker holds the victim's certificate (public key) but signs with its own key.
    const forged = await attacker.sign(canonical);
    const victimKey = await importVerifyingKey(victim.publicKeyJwk);
    if (!victimKey) throw new Error("key import failed");
    expect(await verifyMessageSignature(victimKey, canonical, forged)).toBe(false);

    const genuine = await victim.sign(canonical);
    expect(await verifyMessageSignature(victimKey, canonical, genuine)).toBe(true);
  });

  it("a signature does not carry over to a tampered body", async () => {
    const signer = await createMessageSigner();
    if (!signer) throw new Error("Web Crypto unavailable");
    const key = await importVerifyingKey(signer.publicKeyJwk);
    if (!key) throw new Error("key import failed");

    const original = { kind: "progress", senderDeviceId: "d1", lap: 1, nextGate: 2 };
    const signature = await signer.sign(canonicalMessageString("abcd", "d1", "control", 1, NOW, original));
    const tampered = { ...original, lap: 9 };
    const tamperedCanonical = canonicalMessageString("abcd", "d1", "control", 1, NOW, tampered);
    expect(await verifyMessageSignature(key, tamperedCanonical, signature)).toBe(false);
  });

  it("orders object keys so both peers canonicalise identically", () => {
    expect(stableStringify({ b: 1, a: [3, { d: 4, c: 5 }] })).toBe(
      stableStringify({ a: [3, { c: 5, d: 4 }], b: 1 }),
    );
  });
});

describe("createReplayGuard", () => {
  it("refuses a sequence number it has already seen", () => {
    const guard = createReplayGuard();
    expect(guard.accept("d1", 1, NOW, NOW)).toBe(true);
    expect(guard.accept("d1", 2, NOW, NOW)).toBe(true);
    // The exact bytes of message 2, rebroadcast by an eavesdropper.
    expect(guard.accept("d1", 2, NOW, NOW)).toBe(false);
    expect(guard.accept("d1", 1, NOW, NOW)).toBe(false);
  });

  it("tracks senders independently", () => {
    const guard = createReplayGuard();
    expect(guard.accept("d1", 5, NOW, NOW)).toBe(true);
    expect(guard.accept("d2", 1, NOW, NOW)).toBe(true);
  });

  it("refuses a message older than the skew window", () => {
    const guard = createReplayGuard();
    expect(guard.accept("d1", 1, NOW - MAX_MESSAGE_AGE_MS - 1, NOW)).toBe(false);
  });
});

describe("replay guard across the two channels", () => {
  it("does not let one channel's sequence starve the other", () => {
    // A room uses two channels: control (ready/progress/standings) and telemetry (transforms
    // at 20-30 Hz). They are delivered independently, so their messages interleave on arrival.
    // With one counter and one guard, whichever lands first advances the sequence and the
    // other channel's perfectly good messages are refused as replays — which is what made
    // remote cars vanish mid-race.
    const guard = createReplayGuard();
    // Sender emits: transform(1), transform(2), progress(3), transform(4)
    expect(guard.accept("d1:telemetry", 1, NOW, NOW)).toBe(true);
    expect(guard.accept("d1:telemetry", 2, NOW, NOW)).toBe(true);
    // The control message arrives after a later transform has already been processed.
    expect(guard.accept("d1:telemetry", 4, NOW, NOW)).toBe(true);
    expect(guard.accept("d1:control", 3, NOW, NOW)).toBe(true);
  });

  it("still refuses a genuine replay within one channel", () => {
    const guard = createReplayGuard();
    expect(guard.accept("d1:telemetry", 7, NOW, NOW)).toBe(true);
    expect(guard.accept("d1:telemetry", 7, NOW, NOW)).toBe(false);
    expect(guard.accept("d1:telemetry", 6, NOW, NOW)).toBe(false);
  });
});

describe("lane binding", () => {
  it("a signature made for one lane does not verify on the other", async () => {
    // Otherwise a captured telemetry frame could be replayed onto the control channel, where
    // its sequence number would be unrelated to what the receiver has already seen.
    const signer = await createMessageSigner();
    if (!signer) throw new Error("Web Crypto unavailable");
    const key = await importVerifyingKey(signer.publicKeyJwk);
    if (!key) throw new Error("key import failed");

    const message = { kind: "transform", senderDeviceId: "d1" };
    const signature = await signer.sign(
      canonicalMessageString("abcd", "d1", "telemetry", 5, NOW, message),
    );
    expect(
      await verifyMessageSignature(
        key,
        canonicalMessageString("abcd", "d1", "telemetry", 5, NOW, message),
        signature,
      ),
    ).toBe(true);
    expect(
      await verifyMessageSignature(
        key,
        canonicalMessageString("abcd", "d1", "control", 5, NOW, message),
        signature,
      ),
    ).toBe(false);
  });

  it("gives each lane its own replay slot", () => {
    expect(replayKey("d1", "control")).not.toBe(replayKey("d1", "telemetry"));
  });
});

describe("createSenderGate", () => {
  const cert = (signature: string): RoomCredential => ({
    deviceId: "peer",
    roomCode: "abcd",
    issuedAt: NOW,
    expiresAt: NOW + CREDENTIAL_TTL_MS,
    publicKeyJwk: KEY,
    signature,
  });

  it("lets a peer back in after it rejoins and its sequence restarts", () => {
    // The bug this encodes: walking from the lobby into the race, refreshing, or a reconnect
    // all mint a new certificate and restart the sequence at 1. Keyed by device alone the
    // receiver kept the old high-water mark and the peer's car froze for the rest of the race.
    const gate = createSenderGate();
    const first = cert("cert-session-1");
    expect(gate.accept(first, "telemetry", 900, NOW + 1000)).toBe(true);

    const rejoined = cert("cert-session-2");
    expect(gate.accept(rejoined, "telemetry", 1, NOW + 2000)).toBe(true);
    expect(gate.accept(rejoined, "telemetry", 2, NOW + 2100)).toBe(true);
  });

  it("still refuses a replay carrying the certificate it was captured with", () => {
    const gate = createSenderGate();
    const session = cert("cert-session-1");
    expect(gate.accept(session, "control", 5, NOW + 1000)).toBe(true);
    expect(gate.accept(session, "control", 5, NOW + 1000)).toBe(false);
    expect(gate.accept(session, "control", 4, NOW + 900)).toBe(false);
  });

  it("does not let one lane's sequence starve the other", () => {
    const gate = createSenderGate();
    const session = cert("cert-session-1");
    expect(gate.accept(session, "telemetry", 40, NOW + 1000)).toBe(true);
    expect(gate.accept(session, "control", 3, NOW + 1000)).toBe(true);
  });

  it("judges freshness by the certificate window, not the receiver's clock", () => {
    // Two devices can disagree by minutes. Comparing against the local wall clock discarded
    // every message in one direction and the other player simply never appeared.
    const gate = createSenderGate();
    const session = cert("cert-session-1");
    // Sender's clock reads hours ahead of ours but still inside what the server signed.
    expect(gate.accept(session, "control", 1, NOW + 5 * 60 * 60 * 1000)).toBe(true);
    // Outside the signed window it is refused regardless of any local clock.
    expect(gate.accept(session, "control", 2, NOW + CREDENTIAL_TTL_MS + 1)).toBe(false);
    expect(gate.accept(session, "control", 3, NOW - 1)).toBe(false);
  });

  it("refuses a message spliced in from an older capture of the same session", () => {
    const gate = createSenderGate();
    const session = cert("cert-session-1");
    expect(gate.accept(session, "control", 10, NOW + 5000)).toBe(true);
    expect(gate.accept(session, "control", 11, NOW + 1000)).toBe(false);
  });
});
