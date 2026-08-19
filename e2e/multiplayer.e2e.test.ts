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
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { GridSlot, PresenceMeta, RoomMessage, Standing } from "@/lib/roomTypes";

const BASE_URL = process.env.E2E_BASE_URL;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const HAVE_ENV = Boolean(BASE_URL && SUPABASE_URL && SUPABASE_ANON_KEY);

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

interface PlayerConn {
  deviceId: string;
  sessionId: string;
  client: SupabaseClient;
  channel: RealtimeChannel;
  presence: PresenceMeta[];
  messages: RoomMessage[];
  waitForSubscribed(): Promise<void>;
  send(msg: RoomMessage): Promise<void>;
  track(meta: PresenceMeta): Promise<void>;
  waitForMessage(pred: (msg: RoomMessage) => boolean, timeoutMs?: number): Promise<RoomMessage>;
  close(): void;
}

function connectPlayer(code: string, deviceId: string): PlayerConn {
  const sessionId = randomUUID();
  const client = createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
    auth: { persistSession: false },
  });
  const channel = client.channel(`room:${code}`, {
    config: { presence: { key: sessionId }, broadcast: { self: false, ack: true } },
  });

  const presenceState: PresenceMeta[] = [];
  const messages: RoomMessage[] = [];
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
    const msg = payload as RoomMessage;
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

  channel.subscribe((status, error) => {
    if (status === "SUBSCRIBED") {
      subscribedResolve?.();
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      subscribedReject?.(error ?? new Error(`realtime subscribe failed: ${status}`));
    }
  });

  return {
    deviceId,
    sessionId,
    client,
    channel,
    presence: presenceState,
    messages,
    waitForSubscribed: () => subscribed,
    async send(msg) {
      const result = await channel.send({ type: "broadcast", event: "msg", payload: msg });
      if (result !== "ok") throw new Error(`broadcast failed: ${result}`);
    },
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
      const host = connectPlayer(code, hostDeviceId);
      const guest = connectPlayer(code, guestDeviceId);
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
