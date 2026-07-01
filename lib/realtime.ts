"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getBrowserClient } from "./supabase-browser";
import type { PresenceMeta, RoomMessage } from "./roomTypes";

/**
 * realtime.ts — the single seam over the Realtime transport.
 *
 * A room is one channel `room:{code}`. Presence carries the roster; a single broadcast
 * event ("msg") carries every RoomMessage, dispatched by `kind`. Swapping Supabase for
 * another relay (e.g. Ably) means reimplementing only this file.
 */

export interface RoomHandle {
  /** Resolves once the relay has acked the broadcast — await before navigating away. */
  send(msg: RoomMessage): Promise<unknown>;
  updatePresence(meta: PresenceMeta): void;
  leave(): void;
}

export interface RoomHandlers {
  onPresence: (members: PresenceMeta[]) => void;
  onMessage: (msg: RoomMessage) => void;
}

export function joinRoom(code: string, initial: PresenceMeta, handlers: RoomHandlers): RoomHandle {
  const supabase = getBrowserClient();
  const channel: RealtimeChannel = supabase.channel(`room:${code}`, {
    config: { presence: { key: initial.deviceId }, broadcast: { self: false } },
  });

  channel.on("presence", { event: "sync" }, () => {
    const state = channel.presenceState() as unknown as Record<string, PresenceMeta[]>;
    const members = Object.values(state)
      .map((entries) => entries[0])
      .filter((m): m is PresenceMeta => Boolean(m));
    handlers.onPresence(members);
  });

  channel.on("broadcast", { event: "msg" }, ({ payload }) => {
    handlers.onMessage(payload as RoomMessage);
  });

  let current = initial;
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") void channel.track(current);
  });

  return {
    send(msg) {
      return channel.send({ type: "broadcast", event: "msg", payload: msg });
    },
    updatePresence(meta) {
      current = meta;
      void channel.track(meta);
    },
    leave() {
      void supabase.removeChannel(channel);
    },
  };
}
