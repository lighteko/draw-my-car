import { describe, expect, it } from "vitest";
import { collapsePresence } from "./presence";
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
