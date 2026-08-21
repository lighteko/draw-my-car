import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These cover the room lifecycle's ordering and idempotency, which is where its failures have
 * been: none of them throw, they just make the room disagree with itself — a race that has
 * ended still reading as live, or a lobby that quietly stops being advertised while someone
 * is sitting in it.
 */

interface Row {
  [column: string]: unknown;
}

const tables: Record<string, Row[]> = { rooms: [], jobs: [] };

/** Enough of the PostgREST builder for this module: filters, ordering, and insert conflicts. */
function from(table: string) {
  const key = table === "rooms" ? "code" : "id";
  const rows = () => tables[table];
  const filters: ((row: Row) => boolean)[] = [];
  let order: { column: string; ascending: boolean } | null = null;
  let limit: number | null = null;
  let pending: { rows: Row[]; conflict: boolean } | null = null;

  const resolve = () => {
    if (pending) {
      return pending.conflict
        ? { data: null, error: { code: "23505", message: "duplicate key" } }
        : { data: pending.rows[0] ?? null, error: null };
    }
    let out = rows().filter((row) => filters.every((f) => f(row)));
    if (order) {
      const { column, ascending } = order;
      out = [...out].sort((a, b) =>
        String(a[column]) < String(b[column]) ? (ascending ? -1 : 1) : ascending ? 1 : -1,
      );
    }
    if (limit !== null) out = out.slice(0, limit);
    return { data: out, error: null };
  };

  const builder = {
    select() {
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return builder;
    },
    like(column: string, pattern: string) {
      const prefix = pattern.replace(/%$/, "");
      filters.push((row) => String(row[column]).startsWith(prefix));
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    order(column: string, opts: { ascending: boolean }) {
      order = { column, ascending: opts.ascending };
      return builder;
    },
    limit(n: number) {
      limit = n;
      return builder;
    },
    insert(input: Row) {
      // The real columns default to now(); rowToRoom parses them, so the stub must too.
      const now = new Date().toISOString();
      const row: Row = { created_at: now, updated_at: now, ...input };
      const conflict = rows().some((existing) => existing[key] === row[key]);
      if (!conflict) rows().push(row);
      pending = { rows: [row], conflict };
      return builder;
    },
    upsert(row: Row) {
      const index = rows().findIndex((existing) => existing[key] === row[key]);
      if (index >= 0) rows()[index] = row;
      else rows().push(row);
      pending = { rows: [row], conflict: false };
      return builder;
    },
    update(patch: Row) {
      const matched = rows().filter((row) => filters.every((f) => f(row)));
      matched.forEach((row) => Object.assign(row, patch));
      pending = { rows: matched, conflict: false };
      return builder;
    },
    async maybeSingle() {
      const result = resolve();
      if (pending) return result;
      const list = result.data as Row[];
      return { data: list[0] ?? null, error: null };
    },
    then(onFulfilled: (value: unknown) => unknown) {
      return Promise.resolve(resolve()).then(onFulfilled);
    },
  };
  return builder;
}

vi.mock("./supabase", () => ({ getServiceClient: () => ({ from }) }));

const {
  createRoom,
  finishRoomRace,
  getRoom,
  listOpenRooms,
  reportRoomOccupancy,
  resetRoomToLobby,
  startRoomRace,
  updateRoomSettings,
} = await import("./rooms");

const race = (raceId: string) => ({
  raceId,
  trackId: "t1",
  laps: 1,
  grid: [{ deviceId: "d1", slot: 0 }],
  createdAt: 1,
  startAt: 2,
});

beforeEach(() => {
  tables.rooms = [];
  tables.jobs = [];
});

async function freshRoom() {
  const { room } = await createRoom("owner");
  return room;
}

describe("room state overlay", () => {
  it("resolves the highest revision even when the clock disagrees", async () => {
    // A reset written a hair "before" the start it supersedes — a clock step, or two writes
    // inside the same tick. Ordering by time put the room back into a race that was over.
    let room = await freshRoom();
    room = (await startRoomRace(room, race("r1")))!;
    room = (await resetRoomToLobby(room))!;
    const events = tables.jobs.filter((row) => String(row.id).startsWith("room-state:"));
    expect(events).toHaveLength(2);
    events[1].updated_at = "2000-01-01T00:00:00.000Z";
    events[0].updated_at = "2030-01-01T00:00:00.000Z";

    expect((await getRoom(room.code))?.status).toBe("lobby");
  });
});

describe("finishRoomRace", () => {
  it("closes the race and tolerates being called twice", async () => {
    let room = await freshRoom();
    room = (await startRoomRace(room, race("r1")))!;
    const finished = await finishRoomRace(room, "r1");
    expect(finished?.status).toBe("finished");
    // The second call is a no-op rather than a transition, which is what lets the route treat
    // a repeat as success.
    expect(await finishRoomRace(finished!, "r1")).toBeUndefined();
  });

  it("refuses to end a race it was not told about", async () => {
    let room = await freshRoom();
    room = (await startRoomRace(room, race("r2")))!;
    expect(await finishRoomRace(room, "r1")).toBeUndefined();
  });

  it("lets the owner reopen the lobby from finished", async () => {
    let room = await freshRoom();
    room = (await startRoomRace(room, race("r1")))!;
    room = (await finishRoomRace(room, "r1"))!;
    expect((await resetRoomToLobby(room))?.status).toBe("lobby");
  });
});

describe("listOpenRooms", () => {
  it("keeps advertising a room after its settings change", async () => {
    // The regression: occupancy used to live in the settings blob, so the first state event
    // hid every later report and the room vanished from the browser with its host still in it.
    const room = await freshRoom();
    await updateRoomSettings(room, { ...room.settings, laps: 2 });
    await reportRoomOccupancy(room.code, 2);

    expect(await listOpenRooms()).toEqual([
      expect.objectContaining({ code: room.code, players: 2, laps: 2 }),
    ]);
  });

  it("hides rooms that are empty, full, racing, or reported by a host that went quiet", async () => {
    const empty = await freshRoom();
    await reportRoomOccupancy(empty.code, 0);

    const full = await freshRoom();
    await reportRoomOccupancy(full.code, full.settings.maxPlayers);

    const racing = await freshRoom();
    await reportRoomOccupancy(racing.code, 2);
    await startRoomRace(racing, race("r1"));

    const quiet = await freshRoom();
    await reportRoomOccupancy(quiet.code, 2);
    const report = tables.jobs.find((row) => row.id === `room-occupancy:${quiet.code}`)!;
    (report.data as { at: number }).at = Date.now() - 10 * 60 * 1000;

    expect(await listOpenRooms()).toEqual([]);
  });
});
