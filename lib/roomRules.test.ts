import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type RaceSettings, type RaceSnapshot } from "./roomTypes";
import {
  createGrid,
  gridMembership,
  isProgressUpdateAllowed,
  isRaceSettings,
  isRaceSnapshot,
  isRoomMessageForRace,
  parseRaceSettings,
  parseRoomMessage,
  parseRaceSnapshot,
  progressScore,
} from "./roomRules";

describe("parseRaceSettings", () => {
  it("accepts every supported lap and player-count option", () => {
    for (const laps of [1, 2]) {
      for (const maxPlayers of [2, 4, 6, 8]) {
        expect(
          parseRaceSettings({ trackId: "random", raceType: "circuit", laps, maxPlayers }),
        ).toEqual({ trackId: "random", raceType: "circuit", laps, maxPlayers });
      }
    }
    expect(isRaceSettings(DEFAULT_SETTINGS)).toBe(true);
  });

  it.each([
    null,
    [],
    "settings",
    {},
    { trackId: "map", raceType: "circuit", laps: 1 },
    { ...DEFAULT_SETTINGS, debug: true },
    { ...DEFAULT_SETTINGS, trackId: "" },
    { ...DEFAULT_SETTINGS, trackId: "   " },
    { ...DEFAULT_SETTINGS, trackId: "x".repeat(129) },
    { ...DEFAULT_SETTINGS, raceType: "sprint" },
    { ...DEFAULT_SETTINGS, laps: 0 },
    { ...DEFAULT_SETTINGS, laps: 3 },
    { ...DEFAULT_SETTINGS, laps: "1" },
    { ...DEFAULT_SETTINGS, maxPlayers: 3 },
    { ...DEFAULT_SETTINGS, maxPlayers: "8" },
  ])("rejects malformed settings: %j", (value) => {
    expect(parseRaceSettings(value)).toBeNull();
    expect(isRaceSettings(value)).toBe(false);
  });

  it("rejects symbol and non-enumerable extra keys", () => {
    const symbolExtra = { ...DEFAULT_SETTINGS, [Symbol("extra")]: true };
    const hiddenExtra = { ...DEFAULT_SETTINGS } as RaceSettings & { hidden?: boolean };
    Object.defineProperty(hiddenExtra, "hidden", { value: true, enumerable: false });

    expect(parseRaceSettings(symbolExtra)).toBeNull();
    expect(parseRaceSettings(hiddenExtra)).toBeNull();
  });
});

describe("createGrid", () => {
  it("creates stable contiguous slots", () => {
    expect(createGrid(["alpha", "bravo", "charlie"], 4)).toEqual([
      { deviceId: "alpha", slot: 0 },
      { deviceId: "bravo", slot: 1 },
      { deviceId: "charlie", slot: 2 },
    ]);
    expect(createGrid([], 0)).toEqual([]);
  });

  it.each([
    { ids: ["alpha", "alpha"], max: 2, message: "unique" },
    { ids: ["alpha", ""], max: 2, message: "non-empty" },
    { ids: ["alpha", "  "], max: 2, message: "non-empty" },
    { ids: ["alpha", "bravo", "charlie"], max: 2, message: "exceeds" },
    { ids: [], max: -1, message: "non-negative" },
    { ids: [], max: 1.5, message: "non-negative" },
  ])("rejects invalid admission input", ({ ids, max, message }) => {
    expect(() => createGrid(ids, max)).toThrow(message);
  });

  it("rejects exactly maxPlayers + 1 without truncating the roster", () => {
    expect(createGrid(["a", "b"], 2)).toHaveLength(2);
    expect(() => createGrid(["a", "b", "c"], 2)).toThrow("exceeds maxPlayers");
  });
});

describe("parseRaceSnapshot", () => {
  const valid: RaceSnapshot = {
    raceId: "race-1",
    trackId: "official-jericho",
    laps: 2,
    grid: [
      { deviceId: "alpha", slot: 0 },
      { deviceId: "bravo", slot: 1 },
    ],
    startAt: 2_000,
    createdAt: 1_000,
  };

  it("accepts a complete snapshot and detaches its grid", () => {
    const parsed = parseRaceSnapshot(valid);
    expect(parsed).toEqual(valid);
    expect(parsed).not.toBe(valid);
    expect(parsed?.grid).not.toBe(valid.grid);
    expect(isRaceSnapshot(valid)).toBe(true);
  });

  it("accepts a contiguous grid regardless of array order", () => {
    expect(
      parseRaceSnapshot({
        ...valid,
        grid: [
          { deviceId: "bravo", slot: 1 },
          { deviceId: "alpha", slot: 0 },
        ],
      }),
    ).not.toBeNull();
  });

  it("accepts the exact identifier and positive timestamp boundaries", () => {
    expect(
      parseRaceSnapshot({
        ...valid,
        raceId: "r".repeat(256),
        trackId: "t".repeat(128),
        createdAt: Number.MIN_VALUE,
        startAt: Number.MIN_VALUE,
      }),
    ).not.toBeNull();
  });

  it.each([
    null,
    {},
    { ...valid, extra: true },
    { ...valid, raceId: " " },
    { ...valid, raceId: "r".repeat(257) },
    { ...valid, trackId: "" },
    { ...valid, trackId: "x".repeat(129) },
    { ...valid, laps: 3 },
    { ...valid, grid: "alpha" },
    { ...valid, grid: [] },
    { ...valid, grid: [{ deviceId: "d".repeat(257), slot: 0 }] },
    { ...valid, grid: [{ deviceId: "alpha", slot: 0, extra: true }] },
    { ...valid, grid: [{ deviceId: "", slot: 0 }] },
    {
      ...valid,
      grid: [
        { deviceId: "alpha", slot: 0 },
        { deviceId: "alpha", slot: 1 },
      ],
    },
    {
      ...valid,
      grid: [
        { deviceId: "alpha", slot: 0 },
        { deviceId: "bravo", slot: 0 },
      ],
    },
    {
      ...valid,
      grid: [
        { deviceId: "alpha", slot: 0 },
        { deviceId: "bravo", slot: 2 },
      ],
    },
    { ...valid, grid: [{ deviceId: "alpha", slot: -1 }] },
    { ...valid, grid: [{ deviceId: "alpha", slot: 0.5 }] },
    { ...valid, startAt: 0 },
    { ...valid, startAt: Number.POSITIVE_INFINITY },
    { ...valid, createdAt: -1 },
    { ...valid, createdAt: Number.NaN },
    { ...valid, createdAt: 2_001, startAt: 2_000 },
  ])("rejects malformed snapshots", (value) => {
    expect(parseRaceSnapshot(value)).toBeNull();
    expect(isRaceSnapshot(value)).toBe(false);
  });
});

describe("progress rules", () => {
  const current = { lap: 0, nextGate: 2 };

  it("accepts idempotent duplicates and forward progress", () => {
    expect(isProgressUpdateAllowed(current, current, 4, 2)).toBe(true);
    expect(isProgressUpdateAllowed(current, { lap: 0, nextGate: 3 }, 4, 2)).toBe(true);
    expect(isProgressUpdateAllowed(current, { lap: 1, nextGate: 1 }, 4, 2)).toBe(true);
    expect(progressScore({ lap: 1, nextGate: 1 }, 4)).toBe(4);
  });

  it("rejects reversed and out-of-range progress", () => {
    expect(isProgressUpdateAllowed(current, { lap: 0, nextGate: 1 }, 4, 2)).toBe(false);
    expect(isProgressUpdateAllowed(current, { lap: -1, nextGate: 3 }, 4, 2)).toBe(false);
    expect(isProgressUpdateAllowed(current, { lap: 3, nextGate: 0 }, 4, 2)).toBe(false);
    expect(isProgressUpdateAllowed(current, { lap: 0, nextGate: 4 }, 4, 2)).toBe(false);
  });
});

describe("gridMembership", () => {
  const grid = createGrid(["alpha", "bravo"], 2);
  const snapshot: RaceSnapshot = {
    raceId: "race-1",
    trackId: "track-1",
    laps: 1,
    grid,
    startAt: 2,
    createdAt: 1,
  };

  it("returns the authoritative slot for a grid or snapshot", () => {
    expect(gridMembership(grid, "bravo")).toEqual({ deviceId: "bravo", slot: 1 });
    expect(gridMembership(snapshot, "alpha")).toEqual({ deviceId: "alpha", slot: 0 });
  });

  it("returns null for devices outside the grid", () => {
    expect(gridMembership(grid, "charlie")).toBeNull();
    expect(gridMembership(snapshot, "")).toBeNull();
  });
});

describe("parseRoomMessage", () => {
  it("accepts a complete control message", () => {
    expect(parseRoomMessage({ kind: "room_changed", version: "v2" })).toEqual({
      kind: "room_changed",
      version: "v2",
    });
  });

  it("accepts finite transform telemetry", () => {
    expect(
      parseRoomMessage({
        kind: "transform",
        raceId: "race-1",
        senderDeviceId: "alpha",
        deviceId: "alpha",
        p: [1, 2, 3],
        q: [0, 0, 0, 1],
      }),
    ).not.toBeNull();
  });

  it("accepts an atomic finish with its final progress", () => {
    expect(
      parseRoomMessage({
        kind: "finished",
        raceId: "race-1",
        senderDeviceId: "alpha",
        deviceId: "alpha",
        lap: 2,
        nextGate: 1,
        totalMs: 12_345,
      }),
    ).not.toBeNull();
  });

  it("separates active-race messages from stale race traffic", () => {
    const message = parseRoomMessage({
      kind: "progress",
      raceId: "race-1",
      senderDeviceId: "alpha",
      deviceId: "alpha",
      lap: 1,
      nextGate: 0,
    });
    expect(message).not.toBeNull();
    expect(isRoomMessageForRace(message!, "race-1")).toBe(true);
    expect(isRoomMessageForRace(message!, "race-2")).toBe(false);
  });

  it.each(["transform", "progress", "finished", "progress_state"])(
    "rejects a forged %s sender/device mismatch",
    (kind) => {
      const base = {
        kind,
        raceId: "race-1",
        senderDeviceId: "attacker",
        deviceId: "victim",
      };
      const payload =
        kind === "transform"
          ? { ...base, p: [0, 0, 0], q: [0, 0, 0, 1] }
          : kind === "finished"
            ? { ...base, lap: 1, nextGate: 0, totalMs: 1 }
            : kind === "progress_state"
              ? { ...base, lap: 1, nextGate: 0, finished: false, totalMs: null }
              : { ...base, lap: 1, nextGate: 0 };
      expect(parseRoomMessage(payload)).toBeNull();
    },
  );

  it.each([
    null,
    { kind: "unknown" },
    { kind: "room_changed", version: "v2", injected: true },
    { kind: "room_changed", version: "   " },
    {
      kind: "transform",
      raceId: "race-1",
      senderDeviceId: "alpha",
      deviceId: "alpha",
      p: [Number.NaN, 0, 0],
      q: [0, 0, 0, 1],
    },
    {
      kind: "progress",
      raceId: "race-1",
      senderDeviceId: "alpha",
      deviceId: "alpha",
      lap: -1,
      nextGate: 0,
    },
    {
      kind: "finished",
      raceId: "race-1",
      senderDeviceId: "alpha",
      deviceId: "alpha",
      lap: 1,
      nextGate: 0,
      totalMs: -1,
    },
    {
      kind: "standings",
      raceId: "race-1",
      senderDeviceId: "owner",
      entries: [
        {
          deviceId: "alpha",
          username: "A",
          carName: null,
          lap: 0,
          progress: 0,
          finished: false,
          totalMs: null,
        },
        {
          deviceId: "alpha",
          username: "A again",
          carName: null,
          lap: 0,
          progress: 0,
          finished: false,
          totalMs: null,
        },
      ],
    },
  ])("rejects malformed public payloads", (value) => {
    expect(parseRoomMessage(value)).toBeNull();
  });
});
