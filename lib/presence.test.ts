import { describe, expect, it } from "vitest";
import { collapsePresence, latestPresencePerKey } from "./presence";
import type { PresenceMeta } from "./roomTypes";

function member(sessionId: string, ready: boolean): PresenceMeta {
  return {
    deviceId: "device-1",
    sessionId,
    username: "Player",
    role: "player",
    carId: null,
    carName: null,
    ready,
  };
}

describe("collapsePresence", () => {
  it("selects the same canonical tab regardless of presence ordering", () => {
    const primary = member("device-1:a", true);
    const duplicate = member("device-1:z", false);

    expect(collapsePresence([primary, duplicate])).toEqual([primary]);
    expect(collapsePresence([duplicate, primary])).toEqual([primary]);
  });

  it("promotes the remaining duplicate after the canonical tab leaves", () => {
    const duplicate = member("device-1:z", false);
    expect(collapsePresence([duplicate])).toEqual([duplicate]);
  });
});

describe("latestPresencePerKey", () => {
  const meta = (sessionId: string, ready: boolean): PresenceMeta => ({
    deviceId: "device-a",
    sessionId,
    username: "racer",
    role: "player",
    carId: null,
    carName: null,
    ready,
  });

  it("keeps only the newest meta when a key re-tracks", () => {
    // Supabase appends on re-track, so the array holds both the joining state and the
    // current one. Reading both used to resurrect the stale copy and freeze the roster.
    const state = { "device-a:s1": [meta("device-a:s1", false), meta("device-a:s1", true)] };
    expect(latestPresencePerKey(state).map((m) => m.ready)).toEqual([true]);
  });

  it("returns one entry per key and skips empty arrays", () => {
    const state = {
      "device-a:s1": [meta("device-a:s1", true)],
      "device-b:s2": [],
    };
    expect(latestPresencePerKey(state)).toHaveLength(1);
  });
});
