"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getBrowserClient } from "./supabase-browser";
import type { PresenceMeta, RoomMessage } from "./roomTypes";
import { parseRoomMessage } from "./roomRules";

/**
 * realtime.ts — the single seam over the Realtime transport.
 *
 * A room uses a reliable control channel `room:{code}` for Presence and state changes,
 * plus a best-effort `room:{code}:telemetry` channel for high-frequency car transforms.
 * Both use one broadcast event ("msg"), dispatched by `kind`. Swapping Supabase for
 * another relay (e.g. Ably) means reimplementing only this file.
 */

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
    const members = Object.values(state)
      .flatMap((entries) => entries)
      .filter((m): m is PresenceMeta => Boolean(m));
    handlers.onPresence(members);
  });

  channel.on("broadcast", { event: "msg" }, ({ payload }) => {
    const message = parseRoomMessage(payload);
    if (message) handlers.onMessage(message);
  });

  telemetryChannel.on("broadcast", { event: "msg" }, ({ payload }) => {
    const message = parseRoomMessage(payload);
    if (!message) return;
    if (message.kind === "transform") handlers.onMessage(message);
  });

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
        payload: { kind: "player_state", member: snapshot } satisfies RoomMessage,
      });
    } finally {
      broadcastingState = false;
      if (subscribed && current !== snapshot) void syncPlayerState();
    }
  };

  notifyStatus("connecting");
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
      if (msg.kind === "transform") {
        // Transforms are ephemeral. Dropping the first few frames while telemetry joins
        // avoids Realtime's REST fallback and keeps the control channel free of 20-30 Hz acks.
        if (!telemetrySubscribed) return;
        await telemetryChannel.send({ type: "broadcast", event: "msg", payload: msg });
        return;
      }
      const result = await channel.send({ type: "broadcast", event: "msg", payload: msg });
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
      notifyStatus("disconnected");
      rejectReadyWaiters(new Error("Realtime room was left before subscribing"));
      void supabase.removeChannel(channel);
      void supabase.removeChannel(telemetryChannel);
    },
  };
}
