/**
 * multiplayer.e2e.test.ts — two-client end-to-end harness for the room lifecycle.
 *
 * This talks to a REAL running dev server and a REAL Supabase project. It is intentionally
 * excluded from `npm test` / `npx vitest run` (see the root vitest.config.mts `exclude`).
 *
 * How to run:
 *   1. In one terminal: `npm run dev` (make sure .env has NEXT_PUBLIC_SUPABASE_URL and either
 *      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY, plus a service key
 *      for the server routes).
 *   2. In another terminal:
 *        E2E_BASE_URL=http://localhost:3000 npm run test:e2e
 *
 * Without E2E_BASE_URL set, every test in this file is skipped (describe.skipIf), so plain
 * `npx vitest run` stays green and offline.
 *
 * The harness drives the system exactly the way a browser would: plain `fetch` calls against
 * the app's own /api/rooms routes (carrying the owner cookie by hand, since Node's fetch does
 * not have a cookie jar), plus two independent `@supabase/supabase-js` Realtime clients that
 * replicate the wire protocol implemented in lib/realtime.ts (one broadcast event named "msg",
 * dispatched by `kind`; presence tracked under the member's sessionId) without importing that
 * "use client" module, which caches a single browser client and would collapse both players
 * onto one connection.
 *
 * Every broadcast is signed exactly the way a real client signs it: each player generates its
 * own ECDSA P-256 keypair (createMessageSigner), fetches a server-issued certificate from
 * POST /api/rooms/[code]/token, and every outbound payload carries `{ __cred, __seq, __ts,
 * __sig }` per roomMessageAuth.ts. The canonical string and envelope helpers are imported from
 * lib/roomMessageAuth.ts rather than reimplemented, so the harness cannot silently drift from
 * what the app actually does. Receiver-side verification (certificate check via /verify,
 * per-message signature check, replay guard) is also driven through those same helpers.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { GridSlot, PresenceMeta, RoomMessage, Standing } from "@/lib/roomTypes";
import {
  MESSAGE_SEQ_FIELD,
  MESSAGE_SIGNATURE_FIELD,
  MESSAGE_TIMESTAMP_FIELD,
  canonicalMessageString,
  createMessageSigner,
  createReplayGuard,
  importVerifyingKey,
  parseRoomCredential,
  verifyMessageSignature,
  withCredential,
  type MessageSigner,
  type RoomCredential,
} from "@/lib/roomMessageAuth";

const BASE_URL = process.env.E2E_BASE_URL;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const HAVE_ENV = Boolean(BASE_URL && SUPABASE_URL && SUPABASE_ANON_KEY);

// Asking for the suite and silently getting nothing is the worst outcome: it reads as a pass.
// Skipping is only acceptable when the caller never asked for it in the first place.
if (BASE_URL && !HAVE_ENV) {
  const missing = [
    !SUPABASE_URL && "NEXT_PUBLIC_SUPABASE_URL",
    !SUPABASE_ANON_KEY && "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ].filter(Boolean);
  throw new Error(
    `E2E_BASE_URL is set but ${missing.join(", ")} is missing, so the suite would have skipped silently.`,
  );
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers — a minimal hand-rolled cookie jar, since this is meant to look like a browser
// making real fetch calls to the app's own API routes, not a Supabase/DB shortcut.
// ---------------------------------------------------------------------------------------------

interface ApiResult<T> {
  status: number;
  body: T;
  setCookie: string | null;
}

async function api<T = unknown>(
  path: string,
  init: RequestInit & { deviceId?: string; cookie?: string | null } = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  if (init.deviceId) headers.set("x-device-id", init.deviceId);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : (undefined as T);

  let setCookie: string | null = null;
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const values = getSetCookie.call(res.headers);
    if (values.length > 0) setCookie = values.map((v) => v.split(";")[0]).join("; ");
  } else {
    const raw = res.headers.get("set-cookie");
    if (raw) setCookie = raw.split(";")[0];
  }

  return { status: res.status, body, setCookie };
}

// ---------------------------------------------------------------------------------------------
// Realtime helper — an independent player connection speaking the same protocol as
// lib/realtime.ts: one control channel `room:{code}`, broadcast event "msg" dispatched by
// `kind`, presence tracked under the member's sessionId.
// ---------------------------------------------------------------------------------------------

/** Fetch a signed certificate the same way lib/realtime.ts does: POST /token with our pubkey. */
async function issueCredential(
  code: string,
  deviceId: string,
  publicKeyJwk: string,
): Promise<RoomCredential | null> {
  const res = await api<Record<string, unknown>>(`/api/rooms/${code}/token`, {
    method: "POST",
    deviceId,
    body: JSON.stringify({ publicKeyJwk }),
  });
  if (res.status !== 200) throw new Error(`token request failed: ${res.status}`);
  if (res.body.enforced === false) return null; // deployment has no signing secret configured
  return parseRoomCredential(res.body);
}

interface PlayerConn {
  deviceId: string;
  sessionId: string;
  client: SupabaseClient;
  channel: RealtimeChannel;
  credential: RoomCredential | null;
  signer: MessageSigner | null;
  presence: PresenceMeta[];
  messages: RoomMessage[];
  rawMessages: unknown[];
  waitForSubscribed(): Promise<void>;
  send(msg: RoomMessage): Promise<void>;
  /** Broadcast a raw, pre-built payload — used by the security tests to send malformed envelopes. */
  sendRaw(payload: unknown): Promise<void>;
  /** Build a signed envelope without sending it, so a test can tamper with it first. */
  signEnvelope(code: string, msg: RoomMessage, seq?: number, timestamp?: number): Promise<Record<string, unknown>>;
  track(meta: PresenceMeta): Promise<void>;
  waitForMessage(pred: (msg: RoomMessage) => boolean, timeoutMs?: number): Promise<RoomMessage>;
  close(): void;
}

async function connectPlayer(code: string, deviceId: string): Promise<PlayerConn> {
  const sessionId = randomUUID();
  const client = createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
    auth: { persistSession: false },
  });
  const channel = client.channel(`room:${code}`, {
    config: { presence: { key: sessionId }, broadcast: { self: false, ack: true } },
  });

  // Generate this player's keypair and certificate up front, exactly as lib/realtime.ts does
  // before it ever sends a control message.
  const signer = await createMessageSigner();
  const credential = signer ? await issueCredential(code, deviceId, signer.publicKeyJwk) : null;

  const presenceState: PresenceMeta[] = [];
  const messages: RoomMessage[] = [];
  const rawMessages: unknown[] = [];
  const waiters: Array<{ pred: (msg: RoomMessage) => boolean; resolve: (m: RoomMessage) => void }> = [];

  channel.on("presence", { event: "sync" }, () => {
    const state = channel.presenceState() as unknown as Record<string, PresenceMeta[]>;
    presenceState.length = 0;
    presenceState.push(
      ...Object.values(state)
        .flatMap((entries) => entries)
        .filter((m): m is PresenceMeta => Boolean(m)),
    );
  });

  channel.on("broadcast", { event: "msg" }, ({ payload }) => {
    rawMessages.push(payload);
    // The harness records only the message body for waitForMessage purposes; auth is exercised
    // separately by the security tests below, mirroring the split between splitCredential and
    // parseRoomMessage in lib/realtime.ts.
    const { __cred, __seq, __ts, __sig, ...rest } = payload as Record<string, unknown>;
    void __cred;
    void __seq;
    void __ts;
    void __sig;
    const msg = rest as RoomMessage;
    messages.push(msg);
    for (const waiter of [...waiters]) {
      if (waiter.pred(msg)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(msg);
      }
    }
  });

  let subscribedResolve: (() => void) | null = null;
  let subscribedReject: ((e: Error) => void) | null = null;
  const subscribed = new Promise<void>((resolve, reject) => {
    subscribedResolve = resolve;
    subscribedReject = reject;
  });
  // Once a test has moved on (closed the connection in afterEach), a later CLOSED/error status
  // still fires this same rejection handler. Give it a no-op catch so that doesn't surface as an
  // unhandled rejection — the test itself already observed (or didn't need) the original result.
  subscribed.catch(() => {});

  channel.subscribe((status, error) => {
    if (status === "SUBSCRIBED") {
      subscribedResolve?.();
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      subscribedReject?.(error ?? new Error(`realtime subscribe failed: ${status}`));
    }
  });

  let outboundSeq = 0;

  const signEnvelope = async (
    roomCode: string,
    msg: RoomMessage,
    seqOverride?: number,
    tsOverride?: number,
  ): Promise<Record<string, unknown>> => {
    const base = withCredential(msg, credential);
    if (!signer || !credential) return base;
    const seq = seqOverride ?? ++outboundSeq;
    const timestamp = tsOverride ?? Date.now();
    const canonical = canonicalMessageString(roomCode, credential.deviceId, "control", seq, timestamp, msg);
    return {
      ...base,
      [MESSAGE_SEQ_FIELD]: seq,
      [MESSAGE_TIMESTAMP_FIELD]: timestamp,
      [MESSAGE_SIGNATURE_FIELD]: await signer.sign(canonical),
    };
  };

  return {
    deviceId,
    sessionId,
    client,
    channel,
    credential,
    signer,
    presence: presenceState,
    messages,
    rawMessages,
    waitForSubscribed: () => subscribed,
    async send(msg) {
      const payload = await signEnvelope(code, msg);
      const result = await channel.send({ type: "broadcast", event: "msg", payload });
      if (result !== "ok") throw new Error(`broadcast failed: ${result}`);
    },
    async sendRaw(payload) {
      const result = await channel.send({ type: "broadcast", event: "msg", payload });
      if (result !== "ok") throw new Error(`broadcast failed: ${result}`);
    },
    signEnvelope: (roomCode, msg, seq, timestamp) => signEnvelope(roomCode, msg, seq, timestamp),
    async track(meta) {
      await channel.track(meta);
    },
    waitForMessage(pred, timeoutMs = 10_000) {
      const existing = messages.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise<RoomMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolveWrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`timed out waiting for message after ${timeoutMs}ms`));
        }, timeoutMs);
        const resolveWrapped = (m: RoomMessage): void => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push({ pred, resolve: resolveWrapped });
      });
    },
    close() {
      void client.removeChannel(channel);
    },
  };
}

/** POST /api/rooms/[code]/verify — batched certificate verification, as lib/realtime.ts uses it. */
async function verifyCredentials(
  code: string,
  deviceId: string,
  credentials: unknown[],
): Promise<{ enforced?: boolean; results?: { deviceId: string; signature: string; valid: boolean }[] }> {
  const res = await api<{ enforced?: boolean; results?: { deviceId: string; signature: string; valid: boolean }[] }>(
    `/api/rooms/${code}/verify`,
    { method: "POST", deviceId, body: JSON.stringify({ credentials }) },
  );
  if (res.status !== 200) throw new Error(`verify request failed: ${res.status}`);
  return res.body;
}

/** Create a fresh room and return just its code — used by tests that don't need the owner cookie. */
async function createRoomCode(): Promise<string> {
  const created = await api<{ room: { code: string } }>("/api/rooms", {
    method: "POST",
    deviceId: `owner-${randomUUID()}`,
  });
  if (created.status !== 201) throw new Error(`room creation failed: ${created.status}`);
  return created.body.room.code;
}

function presenceMeta(overrides: Partial<PresenceMeta> & { deviceId: string; sessionId: string }): PresenceMeta {
  return {
    username: overrides.deviceId,
    role: "player",
    carId: null,
    carName: null,
    ready: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Host-side standings aggregation, mirroring what the real host UI does with progress/finished
// broadcasts (this harness plays the role of the browser end to end, so it reproduces that
// small piece of client logic rather than importing app/component code).
// ---------------------------------------------------------------------------------------------

function buildStanding(deviceId: string, lap: number, finished: boolean, totalMs: number | null): Standing {
  return { deviceId, username: deviceId, carName: null, lap, progress: lap, finished, totalMs };
}

describe.skipIf(!HAVE_ENV)("multiplayer room lifecycle (real server + real Supabase)", () => {
  const conns: PlayerConn[] = [];

  afterEach(() => {
    for (const c of conns.splice(0)) c.close();
  });

  it(
    "runs a full two-client race lifecycle: create, join, start, race, reset",
    async () => {
      const hostDeviceId = `host-${randomUUID()}`;
      const guestDeviceId = `guest-${randomUUID()}`;

      // 1. Host creates a room and keeps its owner cookie.
      const created = await api<{ room: { code: string; version: string } }>("/api/rooms", {
        method: "POST",
        deviceId: hostDeviceId,
      });
      expect(created.status).toBe(201);
      expect(created.setCookie).toBeTruthy();
      const code = created.body.room.code;
      const ownerCookie = created.setCookie as string;

      // 2. Both clients subscribe to the room's Realtime channel and exchange presence.
      const [host, guest] = await Promise.all([
        connectPlayer(code, hostDeviceId),
        connectPlayer(code, guestDeviceId),
      ]);
      conns.push(host, guest);
      await Promise.all([host.waitForSubscribed(), guest.waitForSubscribed()]);

      await host.track(presenceMeta({ deviceId: hostDeviceId, sessionId: host.sessionId, role: "player" }));
      await guest.track(presenceMeta({ deviceId: guestDeviceId, sessionId: guest.sessionId, role: "player" }));

      const deadline = Date.now() + 10_000;
      let hostSeesGuest = false;
      let guestSeesHost = false;
      while (Date.now() < deadline && !(hostSeesGuest && guestSeesHost)) {
        hostSeesGuest = host.presence.some((m) => m.deviceId === guestDeviceId);
        guestSeesHost = guest.presence.some((m) => m.deviceId === hostDeviceId);
        if (!(hostSeesGuest && guestSeesHost)) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      expect(hostSeesGuest).toBe(true);
      expect(guestSeesHost).toBe(true);

      // 4. A non-owner starting the race is rejected with 403.
      const forbidden = await api(`/api/rooms/${code}/start`, {
        method: "POST",
        deviceId: guestDeviceId,
        body: JSON.stringify({ expectedVersion: created.body.room.version, playerDeviceIds: [hostDeviceId] }),
      });
      expect(forbidden.status).toBe(403);

      // 4b. A stale expectedVersion is rejected with 409.
      const staleStart = await api(`/api/rooms/${code}/start`, {
        method: "POST",
        deviceId: hostDeviceId,
        cookie: ownerCookie,
        body: JSON.stringify({ expectedVersion: "not-a-real-version", playerDeviceIds: [hostDeviceId] }),
      });
      expect(staleStart.status).toBe(409);

      // 5. maxPlayers is enforced by the start API (default maxPlayers is 8).
      const tooMany = Array.from({ length: 9 }, (_, i) => `overflow-${i}-${randomUUID()}`);
      const overCapacity = await api(`/api/rooms/${code}/start`, {
        method: "POST",
        deviceId: hostDeviceId,
        cookie: ownerCookie,
        body: JSON.stringify({ expectedVersion: created.body.room.version, playerDeviceIds: tooMany }),
      });
      expect(overCapacity.status).toBe(400);

      // 3. Host starts the race for real.
      const start = await api<{
        room: { version: string; race: { raceId: string; trackId: string; laps: number; grid: GridSlot[]; startAt: number } };
      }>(`/api/rooms/${code}/start`, {
        method: "POST",
        deviceId: hostDeviceId,
        cookie: ownerCookie,
        body: JSON.stringify({
          expectedVersion: created.body.room.version,
          playerDeviceIds: [hostDeviceId, guestDeviceId],
        }),
      });
      expect(start.status).toBe(200);
      const race = start.body.room.race;
      expect(race).toBeTruthy();

      // The real host UI broadcasts room_changed once the API call succeeds; replicate that
      // so the guest can converge on the new version the way the actual client does.
      await host.send({ kind: "room_changed", version: start.body.room.version });
      await guest.waitForMessage((m) => m.kind === "room_changed");

      const guestView = await api<{ room: { version: string; race: typeof race } }>(`/api/rooms/${code}`, {
        method: "GET",
      });
      expect(guestView.status).toBe(200);

      // Both clients converge on the SAME raceId, trackId, laps, grid and startAt.
      expect(guestView.body.room.race?.raceId).toBe(race?.raceId);
      expect(guestView.body.room.race?.trackId).toBe(race?.trackId);
      expect(guestView.body.room.race?.laps).toBe(race?.laps);
      expect(guestView.body.room.race?.startAt).toBe(race?.startAt);
      expect(guestView.body.room.race?.grid).toEqual(race?.grid);

      const raceId = race!.raceId;

      // 6. Progress and finish messages from the guest reach the host, and the host's
      // standings (built the same way the real host UI would) reflect them.
      await guest.send({
        kind: "progress",
        raceId,
        senderDeviceId: guestDeviceId,
        deviceId: guestDeviceId,
        lap: 1,
        nextGate: 2,
      });
      const progressSeen = (await host.waitForMessage(
        (m) => m.kind === "progress" && m.deviceId === guestDeviceId,
      )) as Extract<RoomMessage, { kind: "progress" }>;
      expect(progressSeen.lap).toBe(1);

      await guest.send({
        kind: "finished",
        raceId,
        senderDeviceId: guestDeviceId,
        deviceId: guestDeviceId,
        lap: race!.laps,
        nextGate: 0,
        bestLapMs: 12_000,
        totalMs: 42_000,
      });
      const finishedSeen = (await host.waitForMessage(
        (m) => m.kind === "finished" && m.deviceId === guestDeviceId,
      )) as Extract<RoomMessage, { kind: "finished" }>;
      expect(finishedSeen.totalMs).toBe(42_000);

      const standings: Standing[] = [
        buildStanding(hostDeviceId, 0, false, null),
        buildStanding(guestDeviceId, finishedSeen.lap, true, finishedSeen.totalMs),
      ];
      await host.send({ kind: "standings", raceId, senderDeviceId: hostDeviceId, entries: standings });
      const standingsSeen = (await guest.waitForMessage(
        (m) => m.kind === "standings",
      )) as Extract<RoomMessage, { kind: "standings" }>;
      const guestEntry = standingsSeen.entries.find((e) => e.deviceId === guestDeviceId);
      expect(guestEntry?.finished).toBe(true);
      expect(guestEntry?.totalMs).toBe(42_000);

      // 7. Host resets the room and both clients return to lobby state.
      const reset = await api<{ room: { status: string; version: string } }>(`/api/rooms/${code}/reset`, {
        method: "POST",
        deviceId: hostDeviceId,
        cookie: ownerCookie,
        body: JSON.stringify({ expectedVersion: start.body.room.version, raceId }),
      });
      expect(reset.status).toBe(200);
      expect(reset.body.room.status).toBe("lobby");

      await host.send({ kind: "room_changed", version: reset.body.room.version });
      await guest.waitForMessage(
        (m) => m.kind === "room_changed" && m.version === reset.body.room.version,
      );
      const guestAfterReset = await api<{ room: { status: string } }>(`/api/rooms/${code}`, { method: "GET" });
      expect(guestAfterReset.body.room.status).toBe("lobby");
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------------------------
// Security regression tests — each of these targets a hole the certificate + per-message
// signature design was specifically built to close (see the module doc in
// lib/roomMessageAuth.ts). They exercise the same helpers lib/realtime.ts uses on the wire, not
// a reimplementation, so a real regression in the app would fail these too.
// ---------------------------------------------------------------------------------------------

describe.skipIf(!HAVE_ENV)("room message auth (real server + real Supabase)", () => {
  const conns: PlayerConn[] = [];

  afterEach(() => {
    for (const c of conns.splice(0)) c.close();
  });

  it("requires signing to be enforced on this deployment for the rest of the checks to be meaningful", async () => {
    // Enforcement is off by default outside production, because signing needs crypto.subtle
    // and a phone on a LAN dev server (plain http) does not have it — leaving it on there
    // silently blackholes that player. These checks therefore need it switched on explicitly:
    //
    //   ROOM_MESSAGE_ENFORCE=1 npm run dev      (in the server's terminal)
    //
    // Failing loudly beats skipping: a green run that verified nothing is worse than a red one.
    const code = await createRoomCode();
    const res = await fetch(`${BASE_URL}/api/rooms/${code}/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-id": "enforcement-probe" },
      body: JSON.stringify({ publicKeyJwk: "{}" }),
    });
    const body = (await res.json()) as { enforced?: boolean };
    expect(
      body.enforced,
      "server reports signing disabled — restart it with ROOM_MESSAGE_ENFORCE=1 to run the auth checks",
    ).toBe(true);
  });

  it("rejects a message signed with the attacker's key but carrying the victim's valid certificate", async () => {
    const code = await createRoomCode();
    const victim = await connectPlayer(code, `victim-${randomUUID()}`);
    const attacker = await connectPlayer(code, `attacker-${randomUUID()}`);
    conns.push(victim, attacker);
    await Promise.all([victim.waitForSubscribed(), attacker.waitForSubscribed()]);

    expect(victim.credential).not.toBeNull();
    expect(attacker.signer).not.toBeNull();

    // Attacker forges a payload: victim's certificate (a valid, server-issued binding of victim's
    // deviceId to victim's public key), but signs it with the attacker's OWN private key.
    const forgedMsg: RoomMessage = { kind: "room_changed", version: "forged" };
    const seq = 1;
    const timestamp = Date.now();
    const canonical = canonicalMessageString(code, victim.credential!.deviceId, "control", seq, timestamp, forgedMsg);
    const forgedPayload = {
      ...forgedMsg,
      __cred: victim.credential, // genuine certificate for the victim
      [MESSAGE_SEQ_FIELD]: seq,
      [MESSAGE_TIMESTAMP_FIELD]: timestamp,
      [MESSAGE_SIGNATURE_FIELD]: await attacker.signer!.sign(canonical), // but attacker's signature
    };

    // The certificate itself checks out (it's genuine and issued to the victim for this room).
    const verifyResult = await verifyCredentials(code, victim.deviceId, [victim.credential]);
    expect(verifyResult.results?.[0]?.valid).toBe(true);

    // But verifying the message signature against the CERTIFIED public key (the victim's, per
    // the certificate) must fail, because it was actually signed by the attacker's key.
    const victimKey = await importVerifyingKey(victim.credential!.publicKeyJwk);
    expect(victimKey).not.toBeNull();
    const sigOk = await verifyMessageSignature(
      victimKey!,
      canonical,
      forgedPayload[MESSAGE_SIGNATURE_FIELD] as string,
    );
    expect(sigOk).toBe(false);
  });

  it("rejects a message whose body was modified after signing", async () => {
    const code = await createRoomCode();
    const sender = await connectPlayer(code, `sender-${randomUUID()}`);
    conns.push(sender);
    await sender.waitForSubscribed();
    expect(sender.credential).not.toBeNull();

    const original: RoomMessage = { kind: "room_changed", version: "v1" };
    const seq = 1;
    const timestamp = Date.now();
    const envelope = await sender.signEnvelope(code, original, seq, timestamp);
    const signature = envelope[MESSAGE_SIGNATURE_FIELD] as string;

    const key = await importVerifyingKey(sender.credential!.publicKeyJwk);
    expect(key).not.toBeNull();

    // The original, unmodified message verifies fine against its own signature.
    const canonicalOriginal = canonicalMessageString(code, sender.credential!.deviceId, "control", seq, timestamp, original);
    expect(await verifyMessageSignature(key!, canonicalOriginal, signature)).toBe(true);

    // A receiver re-derives the canonical string from the (possibly tampered) body it actually
    // received. Tamper with the body after signing, the way a compromised relay would, and the
    // re-derived canonical string no longer matches what was signed.
    const tamperedBody: RoomMessage = { kind: "room_changed", version: "v2-attacker-modified" };
    const canonicalTampered = canonicalMessageString(code, sender.credential!.deviceId, "control", seq, timestamp, tamperedBody);
    expect(await verifyMessageSignature(key!, canonicalTampered, signature)).toBe(false);
  });

  it("refuses a replayed message (identical __seq) via the replay guard", async () => {
    const guard = createReplayGuard();
    const deviceId = `replay-${randomUUID()}`;
    const now = Date.now();

    expect(guard.accept(deviceId, 1, now)).toBe(true);
    // Same seq again — a captured/rebroadcast message — must be refused even though the
    // timestamp and signature would otherwise be valid.
    expect(guard.accept(deviceId, 1, now)).toBe(false);
    // A stale/out-of-order seq is refused too.
    expect(guard.accept(deviceId, 1, now + 10)).toBe(false);
    // Seq must strictly increase to be accepted.
    expect(guard.accept(deviceId, 2, now + 10)).toBe(true);
  });

  it("rejects a certificate whose deviceId was altered after issuance", async () => {
    const code = await createRoomCode();
    const player = await connectPlayer(code, `player-${randomUUID()}`);
    conns.push(player);
    await player.waitForSubscribed();
    expect(player.credential).not.toBeNull();

    const forged: RoomCredential = { ...player.credential!, deviceId: `not-${player.deviceId}` };
    const result = await verifyCredentials(code, player.deviceId, [forged]);
    expect(result.results?.[0]?.valid).toBe(false);

    // The untouched credential still verifies, proving the rejection above is specifically due
    // to the deviceId tampering.
    const control = await verifyCredentials(code, player.deviceId, [player.credential]);
    expect(control.results?.[0]?.valid).toBe(true);
  });

  it("rejects a certificate replayed into a different room code", async () => {
    const codeA = await createRoomCode();
    const codeB = await createRoomCode();
    const player = await connectPlayer(codeA, `player-${randomUUID()}`);
    conns.push(player);
    await player.waitForSubscribed();
    expect(player.credential).not.toBeNull();

    // The certificate was issued for room A. Presenting it to room B's /verify must fail, even
    // though the signature itself is untouched — otherwise a token harvested in one room could
    // be replayed to impersonate a device in another.
    const crossRoom = await verifyCredentials(codeB, player.deviceId, [player.credential]);
    expect(crossRoom.results?.[0]?.valid).toBe(false);

    const sameRoom = await verifyCredentials(codeA, player.deviceId, [player.credential]);
    expect(sameRoom.results?.[0]?.valid).toBe(true);
  });
});
