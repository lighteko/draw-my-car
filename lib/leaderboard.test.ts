import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  data: unknown;
}

let rows: Row[] = [];

function from() {
  const filters: ((row: Row) => boolean)[] = [];
  const builder = {
    select: () => builder,
    like(_column: string, pattern: string) {
      const prefix = pattern.replace(/%$/, "");
      filters.push((row) => row.id.startsWith(prefix));
      return builder;
    },
    in(_column: string, values: unknown[]) {
      filters.push((row) => values.includes(row.id));
      return builder;
    },
    limit: () => builder,
    upsert(incoming: Row[]) {
      for (const row of incoming) {
        const index = rows.findIndex((existing) => existing.id === row.id);
        if (index >= 0) rows[index] = row;
        else rows.push(row);
      }
      return Promise.resolve({ data: incoming, error: null });
    },
    then(onFulfilled: (value: unknown) => unknown) {
      return Promise.resolve({
        data: rows.filter((row) => filters.every((f) => f(row))),
        error: null,
      }).then(onFulfilled);
    },
  };
  return builder;
}

vi.mock("@/lib/supabase", () => ({ getServiceClient: () => ({ from }) }));

const { listLapRecords, recordLapTimes } = await import("./leaderboard");

const lap = (deviceId: string, trackId: string, lapMs: number) => ({
  deviceId,
  username: deviceId,
  trackId,
  lapMs,
});

beforeEach(() => {
  rows = [];
});

describe("recordLapTimes", () => {
  it("keeps the best lap and never lets a slower one overwrite it", async () => {
    await recordLapTimes([lap("d1", "t1", 30_000)]);
    await recordLapTimes([lap("d1", "t1", 45_000)]);
    expect((await listLapRecords()).map((r) => r.lapMs)).toEqual([30_000]);

    await recordLapTimes([lap("d1", "t1", 21_000)]);
    expect((await listLapRecords()).map((r) => r.lapMs)).toEqual([21_000]);
  });

  it("keeps a player's records on different maps apart", async () => {
    await recordLapTimes([lap("d1", "t1", 30_000), lap("d1", "t2", 40_000)]);
    expect(await listLapRecords()).toHaveLength(2);
    expect(await listLapRecords("t2")).toEqual([expect.objectContaining({ lapMs: 40_000 })]);
  });

  it("drops times that are not laps", async () => {
    // A gate mis-registering reads as a lap of a few hundred ms and would top the board
    // forever; an abandoned tab reads as hours.
    await recordLapTimes([lap("d1", "t1", 12), lap("d2", "t1", 5 * 60 * 60 * 1000)]);
    expect(await listLapRecords()).toEqual([]);
  });
});

describe("listLapRecords", () => {
  it("ranks by time, not by the order rows came back", async () => {
    await recordLapTimes([lap("slow", "t1", 90_000), lap("fast", "t1", 30_000)]);
    expect((await listLapRecords()).map((r) => r.deviceId)).toEqual(["fast", "slow"]);
  });
});
