import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatLap, getSoloRecord, listSoloRecords, recordSoloLap } from "./soloRecords";

const store = new Map<string, string>();

vi.stubGlobal("window", {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

beforeEach(() => store.clear());

describe("recordSoloLap", () => {
  it("keeps the best lap per map and rejects a slower one", () => {
    expect(recordSoloLap("t1", 40_000)).toBe(true);
    expect(recordSoloLap("t1", 55_000)).toBe(false);
    expect(getSoloRecord("t1")?.lapMs).toBe(40_000);
    expect(recordSoloLap("t1", 31_000)).toBe(true);
    expect(getSoloRecord("t1")?.lapMs).toBe(31_000);
  });

  it("tracks maps independently", () => {
    recordSoloLap("t1", 40_000);
    recordSoloLap("t2", 60_000);
    expect(listSoloRecords()).toHaveLength(2);
  });

  it("survives storage holding something that is not a record", () => {
    // A garage that throws because localStorage has junk in it is a worse outcome than a
    // history that starts over.
    store.set("dmc_solo_pb", '{"t1":{"lapMs":"fast"},"t2":null}');
    expect(listSoloRecords()).toEqual([]);
    expect(recordSoloLap("t1", 40_000)).toBe(true);
  });
});

describe("formatLap", () => {
  it("reads as a lap time", () => {
    expect(formatLap(31_200)).toBe("31.20");
    expect(formatLap(91_050)).toBe("1:31.05");
    expect(formatLap(9_090)).toBe("9.09");
  });
});
