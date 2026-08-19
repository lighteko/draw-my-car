"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getBrowserClient } from "./supabase-browser";
import { deviceHeaders } from "./identity";
import type { PresenceMeta, RoomMessage } from "./roomTypes";
import { parseRoomMessage } from "./roomRules";
import { latestPresencePerKey } from "./presence";
import {
  MAX_VERIFY_BATCH,
  credentialCacheKey,
  isCredentialConsistent,
  parseRoomCredential,
  splitCredential,
  withCredential,
  type RoomCredential,
} from "./roomMessageAuth";

/**
 * realtime.ts — the single seam over the Realtime transport.
 *
 * A room uses a reliable control channel `room:{code}` for Presence and state changes,
 * plus a best-effort `room:{code}:telemetry` channel for high-frequency car transforms.
 * Both use one broadcast event ("msg"), dispatched by `kind`. Swapping Supabase for
 * another relay (e.g. Ably) means reimplementing only this file.
 *
 * Because those channels are public, every outbound payload carries a server-issued
 * credential and every inbound one is authenticated before it reaches a handler — see
 * roomMessageAuth.ts. Senders are decided at most once per session, so the hot telemetry
 * path stays a pure cache lookup.
 */

/** Coalesce the verify round-trips a burst of new senders would otherwise each trigger. */
const VERIFY_BATCH_MS = 30;
/** Bound on decided senders, so forged signatures cannot grow the cache without limit. */
const VERIFY_CACHE_MAX = 512;
/** Never re-ask for our own token more often than this after a failure. */
const TOKEN_RETRY_MS = 30_000;

interface SenderVerifier {
  /** True once the server has confirmed this credential. Unknown senders return false. */
  isVerified(credential: RoomCredential): boolean;
  /** Switch enforcement off, for deployments with no signing secret configured. */
  disableEnforcement(): void;
  dispose(): void;
}

function createSenderVerifier(code: string): SenderVerifier {
  const decided = new Map<string, boolean>();
  const queued = new Map<string, RoomCredential>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let enforced = true;

  const flush = async (): Promise<void> => {
    timer = null;
    const batch = [...queued.values()].slice(0, MAX_VERIFY_BATCH);
    if (batch.length === 0) return;
    batch.forEach((credential) => queued.delete(credentialCacheKey(credential)));
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", ...deviceHeaders() },
        body: JSON.stringify({ credentials: batch }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        results?: { deviceId?: unknown; signature?: unknown; valid?: unknown }[];
      };
      if (disposed) return;
      // The server tells us signing is off; stop dropping peers we can never verify.
      if ((body as { enforced?: unknown }).enforced === false) {
        enforced = false;
        queued.clear();
        return;
      }
      if (!Array.isArray(body.results)) return;
      // Only record positives: a failed check may just mean the room record was mid-write,
      // and a cached "invalid" would blacklist an honest peer for the whole session.
      for (const result of body.results) {
        if (typeof result.deviceId !== "string" || typeof result.signature !== "string") continue;
        if (result.valid !== true) continue;
        if (decided.size >= VERIFY_CACHE_MAX) decided.clear();
        decided.set(`${result.deviceId} ${result.signature}`, true);
      }
    } catch {
      // Offline or endpoint unreachable: senders simply stay unverified (and dropped).
    }
  };

  return {
    isVerified(credential) {
      if (!enforced) return true;
      const key = credentialCacheKey(credential);
      if (decided.get(key)) return true;
      if (disposed || queued.has(key)) return false;
      if (queued.size < MAX_VERIFY_BATCH) queued.set(key, credential);
      if (timer === null) timer = setTimeout(() => void flush(), VERIFY_BATCH_MS);
      return false;
    },
    disableEnforcement() {
      enforced = false;
      queued.clear();
    },
    dispose() {
      disposed = true;
      queued.clear();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export interface RoomHandle {
  /** Resolves once the relay has acked the broadcast — await before navigating away. */
  send(msg: RoomMessage): Promise<void>;
  /** Resolves when the channel subscribes; rejects if that attempt fails or the room is left. */
  waitUntilReady(): Promise<void>;
  updatePresence(meta: PresenceMeta): void;
  leave(): void;
}

export type RoomConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface RoomHandlers {
  onPresence: (members: PresenceMeta[]) => void;
  onMessage: (msg: RoomMessage) => void;
  onStatus?: (status: RoomConnectionStatus) => void;
}

export function joinRoom(code: string, initial: PresenceMeta, handlers: RoomHandlers): RoomHandle {
  const supabase = getBrowserClient();
  const channel: RealtimeChannel = supabase.channel(`room:${code}`, {
    config: { presence: { key: initial.sessionId }, broadcast: { self: false, ack: true } },
  });
  const telemetryChannel: RealtimeChannel = supabase.channel(`room:${code}:telemetry`, {
    config: { broadcast: { self: false, ack: false } },
  });

  channel.on("presence", { event: "sync" }, () => {
    const state = channel.presenceState() as unknown as Record<string, PresenceMeta[]>;
    const members = latestPresencePerKey(state);
    handlers.onPresence(members);
  });

  const verifier = createSenderVerifier(code);

  /**
   * Authenticate before parsing intent: an unsigned payload, one signed for another room or
   * expired, or one whose signed device disagrees with the device it claims to be, is dropped
   * outright. Dropping (rather than queuing) is what makes the first message from an
   * unverified sender safe — by the time the answer arrives, that message is gone.
   */
  const authenticate = (payload: unknown): RoomMessage | null => {
    const { message, credential } = splitCredential(payload);
    if (!credential) return null;
    if (!isCredentialConsistent(credential, message, code)) return null;
    if (!verifier.isVerified(credential)) return null;
    return parseRoomMessage(message);
  };

  channel.on("broadcast", { event: "msg" }, ({ payload }) => {
    const message = authenticate(payload);
    if (message) handlers.onMessage(message);
  });

  telemetryChannel.on("broadcast", { event: "msg" }, ({ payload }) => {
    const message = authenticate(payload);
    if (!message) return;
    if (message.kind === "transform") handlers.onMessage(message);
  });

  // Our own credential, fetched once per join. A failure is not fatal: we keep sending
  // (unsigned) so this client stays usable, and stay quiet about it.
  let credential: RoomCredential | null = null;
  let lastTokenAttempt = 0;
  const ensureCredential = async (): Promise<void> => {
    if (left || credential) return;
    const now = Date.now();
    if (now - lastTokenAttempt < TOKEN_RETRY_MS) return;
    lastTokenAttempt = now;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/token`, {
        method: "POST",
        headers: { "content-type": "application/json", ...deviceHeaders() },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { enforced?: unknown };
      // Signing is not configured on this deployment: nobody can produce a credential, so
      // requiring one would silently drop every peer. Attribution is off; the room works.
      if (body.enforced === false) {
        verifier.disableEnforcement();
        return;
      }
      const issued = parseRoomCredential(body);
      if (!left) credential = issued;
    } catch {
      /* retried on the next send */
    }
  };

  let current = initial;
  let subscribed = false;
  let telemetrySubscribed = false;
  let left = false;
  let tracking = false;
  let broadcastingState = false;
  let connectionStatus: RoomConnectionStatus | null = null;
  const readyWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

  const notifyStatus = (status: RoomConnectionStatus): void => {
    if (connectionStatus === status) return;
    connectionStatus = status;
    handlers.onStatus?.(status);
  };

  const resolveReadyWaiters = (): void => {
    const waiters = [...readyWaiters];
    readyWaiters.clear();
    waiters.forEach(({ resolve }) => resolve());
  };

  const rejectReadyWaiters = (error: Error): void => {
    const waiters = [...readyWaiters];
    readyWaiters.clear();
    waiters.forEach(({ reject }) => reject(error));
  };

  // Presence updates can be triggered back-to-back (pick car, then ready up).
  // Serialize channel.track calls so an older request cannot finish last and
  // overwrite newer state. If state changes in flight, immediately send the latest.
  const syncPresence = async (): Promise<void> => {
    if (!subscribed || tracking) return;
    tracking = true;
    const snapshot = current;
    try {
      await channel.track(snapshot);
    } finally {
      tracking = false;
      if (subscribed && current !== snapshot) void syncPresence();
    }
  };

  // Mutable player state also travels over Broadcast. Keep it independent from
  // channel.track: Presence can take until its timeout to acknowledge a failed
  // update, while Ready must reach the host immediately.
  const syncPlayerState = async (): Promise<void> => {
    if (!subscribed || broadcastingState) return;
    broadcastingState = true;
    const snapshot = current;
    try {
      await channel.send({
        type: "broadcast",
        event: "msg",
        payload: withCredential(
          { kind: "player_state", member: snapshot } satisfies RoomMessage,
          credential,
        ),
      });
    } finally {
      broadcastingState = false;
      if (subscribed && current !== snapshot) void syncPlayerState();
    }
  };

  notifyStatus("connecting");
  void ensureCredential();
  channel.subscribe((status, error) => {
    if (left) return;

    if (status === "SUBSCRIBED") {
      subscribed = true;
      notifyStatus("connected");
      resolveReadyWaiters();
      void syncPresence();
      void syncPlayerState();
      return;
    }

    subscribed = false;
    if (status === "CLOSED") {
      notifyStatus("disconnected");
      rejectReadyWaiters(new Error("Realtime room subscription closed"));
      return;
    }

    notifyStatus("error");
    rejectReadyWaiters(
      error ??
        new Error(
          status === "TIMED_OUT"
            ? "Realtime room subscription timed out"
            : "Realtime room subscription failed",
        ),
    );
  });
  telemetryChannel.subscribe((status) => {
    if (left) return;
    telemetrySubscribed = status === "SUBSCRIBED";
  });

  return {
    async send(msg) {
      if (left) throw new Error("Cannot send after leaving the Realtime room");
      // Cheap once we hold a token; rate-limited to one attempt per 30s while we do not.
      if (!credential) void ensureCredential();
      if (msg.kind === "transform") {
        // Transforms are ephemeral. Dropping the first few frames while telemetry joins
        // avoids Realtime's REST fallback and keeps the control channel free of 20-30 Hz acks.
        if (!telemetrySubscribed) return;
        await telemetryChannel.send({
          type: "broadcast",
          event: "msg",
          payload: withCredential(msg, credential),
        });
        return;
      }
      const result = await channel.send({
        type: "broadcast",
        event: "msg",
        payload: withCredential(msg, credential),
      });
      if (result !== "ok") throw new Error(`Realtime broadcast ${result}`);
    },
    waitUntilReady() {
      if (subscribed) return Promise.resolve();
      if (left) return Promise.reject(new Error("Realtime room was left before subscribing"));
      return new Promise<void>((resolve, reject) => {
        readyWaiters.add({ resolve, reject });
      });
    },
    updatePresence(meta) {
      current = meta;
      void syncPresence();
      void syncPlayerState();
    },
    leave() {
      if (left) return;
      left = true;
      subscribed = false;
      telemetrySubscribed = false;
      verifier.dispose();
      notifyStatus("disconnected");
      rejectReadyWaiters(new Error("Realtime room was left before subscribing"));
      void supabase.removeChannel(channel);
      void supabase.removeChannel(telemetryChannel);
    },
  };
}
