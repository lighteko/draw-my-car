import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomMessage } from "./roomTypes";

/**
 * The failure these cover is silent and total: every payload is discarded, no error surfaces,
 * and the symptom is only visible three screens away — other cars frozen on the start line and
 * a standings board that always says you are first.
 */

type BroadcastHandler = (args: { payload: unknown }) => void;

const handlers = new Map<string, BroadcastHandler>();

function fakeChannel(name: string) {
  const channel = {
    on(type: string, opts: { event: string }, handler: BroadcastHandler) {
      if (type === "broadcast") handlers.set(name, handler);
      return channel;
    },
    subscribe(cb?: (status: string) => void) {
      cb?.("SUBSCRIBED");
      return channel;
    },
    presenceState: () => ({}),
    track: async () => "ok",
    send: async () => "ok",
  };
  return channel;
}

vi.mock("./supabase-browser", () => ({
  getBrowserClient: () => ({
    channel: (name: string) => fakeChannel(name),
    removeChannel: async () => "ok",
  }),
}));

vi.mock("./identity", () => ({ deviceHeaders: () => ({ "x-device-id": "me" }) }));

const { joinRoom } = await import("./realtime");

const meta = {
  deviceId: "peer",
  sessionId: "peer:1",
  username: "Peer",
  role: "player" as const,
  carId: null,
  carName: null,
  ready: false,
};

function tokenResponds(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch,
  );
}

/** Let the join's /token round trip and the dispatcher's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("joinRoom inbound authentication", () => {
  beforeEach(() => {
    handlers.clear();
    vi.unstubAllGlobals();
  });

  it("delivers unsigned messages once the server says signing is off", async () => {
    tokenResponds({ enforced: false });
    const onMessage = vi.fn();
    const handle = joinRoom("abcde", meta, { onPresence: () => {}, onMessage });
    await settle();

    const message: RoomMessage = { kind: "player_state", member: meta };
    handlers.get("room:abcde")?.({ payload: message });
    await settle();

    expect(onMessage).toHaveBeenCalledWith(message);
    handle.leave();
  });

  it("drops unsigned messages before the server has answered", async () => {
    // A deployment that does enforce must not have an injection window while /token is in
    // flight, so "undecided" is treated as "enforced", not as "off".
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
    const onMessage = vi.fn();
    const handle = joinRoom("abcde", meta, { onPresence: () => {}, onMessage });
    await settle();

    handlers.get("room:abcde")?.({ payload: { kind: "player_state", member: meta } });
    await settle();

    expect(onMessage).not.toHaveBeenCalled();
    handle.leave();
  });
});
