"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getBrowserClient } from "./supabase-browser";
import { deviceHeaders } from "./identity";
import type { PresenceMeta, RoomMessage } from "./roomTypes";
import { parseRoomMessage } from "./roomRules";
import { latestPresencePerKey } from "./presence";
import {
  MAX_VERIFY_BATCH,
  MESSAGE_SEQ_FIELD,
  MESSAGE_SIGNATURE_FIELD,
  MESSAGE_TIMESTAMP_FIELD,
  canonicalMessageString,
  createMessageSigner,
  createSenderGate,
  credentialCacheKey,
  importVerifyingKey,
  isCredentialConsistent,
  parseRoomCredential,
  splitCredential,
  verifyMessageSignature,
  withCredential,
  type MessageLane,
  type MessageSigner,
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
  // Certified keys, imported once per sender. Importing is the only expensive step; the
  // per-message verify that follows is local and needs no network.
  const senderKeys = new Map<string, Promise<CryptoKey | null>>();
  const senderGate = createSenderGate();

  /**
   * Decide whether a payload really came from the device it names.
   *
   * The certificate alone is not proof — it travels in the clear to every member, so anyone
   * can copy one. What settles it is the signature over this exact message, checked against
   * the public key the server certified for that device.
   */
  const authenticate = async (payload: unknown, lane: MessageLane): Promise<RoomMessage | null> => {
    const { message, credential } = splitCredential(payload);
    if (!credential) return null;
    if (!isCredentialConsistent(credential, message, code)) return null;
    if (!verifier.isVerified(credential)) return null;
    const parsed = parseRoomMessage(message);
    if (!parsed) return null;

    const envelope = payload as Record<string, unknown>;
    const signature = envelope[MESSAGE_SIGNATURE_FIELD];
    const seq = envelope[MESSAGE_SEQ_FIELD];
    const timestamp = envelope[MESSAGE_TIMESTAMP_FIELD];
    if (typeof signature !== "string" || typeof seq !== "number" || typeof timestamp !== "number") {
      return null;
    }
    if (!senderGate.accept(credential, lane, seq, timestamp)) return null;

    let keyPromise = senderKeys.get(credential.publicKeyJwk);
    if (!keyPromise) {
      keyPromise = importVerifyingKey(credential.publicKeyJwk);
      senderKeys.set(credential.publicKeyJwk, keyPromise);
    }
    const key = await keyPromise;
    if (!key) return null;
    const canonical = canonicalMessageString(
      code,
      credential.deviceId,
      lane,
      seq,
      timestamp,
      parsed,
    );
    return (await verifyMessageSignature(key, canonical, signature)) ? parsed : null;
  };

  /**
   * Verification is async, so dispatch is serialised per channel: progress messages are
   * order-sensitive and the owner's rules reject a rewind, which would silently drop a lap
   * if two messages from one sender raced each other through the crypto.
   */
  const makeDispatcher = (lane: MessageLane, handle: (msg: RoomMessage) => void) => {
    let chain: Promise<void> = Promise.resolve();
    return (payload: unknown): void => {
      chain = chain
        .then(async () => {
          const message = await authenticate(payload, lane);
          if (message) handle(message);
        })
        .catch(() => {});
    };
  };

  const dispatchControl = makeDispatcher("control", (message) => handlers.onMessage(message));
  const dispatchTelemetry = makeDispatcher("telemetry", (message) => {
    if (message.kind === "transform") handlers.onMessage(message);
  });

  channel.on("broadcast", { event: "msg" }, ({ payload }) => dispatchControl(payload));
  telemetryChannel.on("broadcast", { event: "msg" }, ({ payload }) => dispatchTelemetry(payload));

  // This tab's signing key. Generated once, private half non-extractable, so possession — not
  // mere presentation of a public certificate — is what proves a message came from us.
  let signer: MessageSigner | null = null;
  let signerPromise: Promise<MessageSigner | null> | null = null;
  // One counter per lane. Sharing a counter across the two channels meant whichever message
  // arrived first advanced the receiver's guard and the other lane's traffic was refused as a
  // replay — during a race the 20-30 Hz transforms simply starved everything else out.
  const outboundSeq: Record<MessageLane, number> = { control: 0, telemetry: 0 };
  const ensureSigner = async (): Promise<MessageSigner | null> => {
    if (signer) return signer;
    signerPromise ??= createMessageSigner();
    signer = await signerPromise;
    // No Web Crypto here (an insecure origin, typically a phone on the LAN dev server). We
    // cannot sign, and we equally cannot verify anyone else, so requiring signatures would
    // only blind us. Drop enforcement rather than sit in an empty room.
    if (!signer) verifier.disableEnforcement();
    return signer;
  };

  /**
   * Attach the certificate plus a signature over this exact message. The sequence number and
   * timestamp are inside the signed string, so a captured payload cannot be rebroadcast: the
   * receiver has already moved past that sequence.
   */
  const signedPayload = async (
    msg: RoomMessage,
    lane: MessageLane,
  ): Promise<Record<string, unknown>> => {
    const base = withCredential(msg, credential);
    const active = await ensureSigner();
    if (!active || !credential) return base;
    const seq = ++outboundSeq[lane];
    const timestamp = Date.now();
    const canonical = canonicalMessageString(code, credential.deviceId, lane, seq, timestamp, msg);
    return {
      ...base,
      [MESSAGE_SEQ_FIELD]: seq,
      [MESSAGE_TIMESTAMP_FIELD]: timestamp,
      [MESSAGE_SIGNATURE_FIELD]: await active.sign(canonical),
    };
  };

  // Our own certificate, fetched once per join. A failure is not fatal: we keep sending
  // (unsigned) so this client stays usable, and stay quiet about it.
  let credential: RoomCredential | null = null;
  let lastTokenAttempt = 0;
  const ensureCredential = async (): Promise<void> => {
    if (left || credential) return;
    const now = Date.now();
    if (now - lastTokenAttempt < TOKEN_RETRY_MS) return;
    lastTokenAttempt = now;
    try {
      const active = await ensureSigner();
      if (!active) return;
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/token`, {
        method: "POST",
        headers: { "content-type": "application/json", ...deviceHeaders() },
        body: JSON.stringify({ publicKeyJwk: active.publicKeyJwk }),
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
        payload: await signedPayload(
          { kind: "player_state", member: snapshot } satisfies RoomMessage,
          "control",
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
      // Cheap once we hold a certificate; rate-limited to one attempt per 30s while we do not.
      if (!credential) void ensureCredential();
      if (msg.kind === "transform") {
        // Transforms are ephemeral. Dropping the first few frames while telemetry joins
        // avoids Realtime's REST fallback and keeps the control channel free of 20-30 Hz acks.
        if (!telemetrySubscribed) return;
        await telemetryChannel.send({
          type: "broadcast",
          event: "msg",
          payload: await signedPayload(msg, "telemetry"),
        });
        return;
      }
      const result = await channel.send({
        type: "broadcast",
        event: "msg",
        payload: await signedPayload(msg, "control"),
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
