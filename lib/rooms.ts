import { getServiceClient } from "@/lib/supabase";
import { DEFAULT_SETTINGS, type RaceSettings, type RaceSnapshot } from "@/lib/roomTypes";
import { parseRaceSettings, parseRaceSnapshot } from "@/lib/roomRules";
import { createOwnerToken, hashOwnerToken } from "@/lib/roomOwner";

/**
 * Durable racing-room state. Realtime is only an invalidation signal; settings and the
 * active race snapshot live in the existing settings JSON column. `updated_at` is kept as
 * an exact-string compare-and-swap version, so existing deployments need no schema change.
 */
export type RoomStatus = "lobby" | "racing" | "finished";

export interface Room {
  code: string;
  ownerDeviceId: string;
  status: RoomStatus;
  settings: RaceSettings;
  race: RaceSnapshot | null;
  /** Monotonic mutation revision persisted inside settings JSON. */
  revision: number;
  version: string;
  createdAt: number;
  updatedAt: number;
  /** Server-only capability hash. Never include this field in an API response. */
  ownerTokenHash: string | null;
}

export type PublicRoom = Omit<Room, "ownerTokenHash">;

interface StoredRoomMeta {
  ownerTokenHash?: string;
  race?: RaceSnapshot | null;
  revision?: number;
}

type StoredSettings = RaceSettings & { __room?: StoredRoomMeta };

interface RoomRow {
  code: string;
  owner_device_id: string;
  status: RoomStatus;
  settings: unknown;
  created_at: string;
  updated_at: string;
}

interface RoomEventRow {
  id: string;
  data: { status?: unknown; settings?: unknown };
  updated_at: string;
}

function rowToRoom(r: RoomRow): Room {
  const raw = r.settings && typeof r.settings === "object" ? (r.settings as StoredSettings) : null;
  const settings =
    parseRaceSettings(
      raw
        ? {
            trackId: raw.trackId,
            raceType: raw.raceType,
            laps: raw.laps,
            maxPlayers: raw.maxPlayers,
          }
        : null,
    ) ?? DEFAULT_SETTINGS;
  const meta = raw?.__room;
  return {
    code: r.code,
    ownerDeviceId: r.owner_device_id,
    status: r.status,
    settings,
    race: parseRaceSnapshot(meta?.race) ?? null,
    revision:
      Number.isInteger(meta?.revision) && (meta?.revision as number) >= 0
        ? (meta?.revision as number)
        : -1,
    version: r.updated_at,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
    ownerTokenHash:
      typeof meta?.ownerTokenHash === "string" && meta.ownerTokenHash.length > 0
        ? meta.ownerTokenHash
        : null,
  };
}

/**
 * How many people are actually in a room, as last reported by its host.
 *
 * The server cannot see this for itself: membership lives in Supabase Realtime presence, which
 * only connected clients can read. Rather than guess, the host — which already has the roster
 * on screen — reports it. One writer means no read-modify-write races, and a room whose host
 * has gone quiet simply ages out of the browser, which is the behaviour we wanted anyway.
 *
 * It lives in a row of its own, keyed only by room code. It used to ride inside the settings
 * blob, which put it on the wrong side of the state overlay below: the moment a room recorded
 * any state event — the host picking a different map was enough — reads came from the overlay
 * and every later report was written somewhere nothing read from. The room then aged out of
 * the browser while its host was sitting in it. Being off the revision chain also makes the
 * write idempotent by construction, which matters for something that fires every 15 seconds.
 */
function occupancyRowId(code: string): string {
  return `room-occupancy:${code}`;
}

function parseOccupancy(value: unknown): RoomOccupancy | null {
  if (typeof value !== "object" || value === null) return null;
  const { players, at } = value as { players?: unknown; at?: unknown };
  if (!Number.isInteger(players) || (players as number) < 0) return null;
  if (!Number.isFinite(at)) return null;
  return { players: players as number, at: at as number };
}

function storedSettings(
  room: Room,
  settings: RaceSettings,
  race: RaceSnapshot | null,
  revision = room.revision + 1,
): StoredSettings {
  return {
    ...settings,
    __room: {
      ...(room.ownerTokenHash ? { ownerTokenHash: room.ownerTokenHash } : {}),
      race,
      revision,
    },
  };
}

export interface RoomOccupancy {
  players: number;
  /** Epoch ms of the report, so a silent host's count can be aged out. */
  at: number;
}

export function publicRoom(room: Room): PublicRoom {
  const { ownerTokenHash: _ownerTokenHash, ...safe } = room;
  return safe;
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function genCode(len = 5): string {
  let code = "";
  for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}

export async function createRoom(
  ownerDeviceId: string,
): Promise<{ room: Room; ownerToken: string }> {
  const client = getServiceClient();
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = genCode();
    const ownerToken = createOwnerToken();
    const ownerTokenHash = hashOwnerToken(ownerToken);
    const settings: StoredSettings = {
      ...DEFAULT_SETTINGS,
      __room: { ownerTokenHash, race: null, revision: 0 },
    };
    const { data, error } = await client
      .from("rooms")
      .insert({ code, owner_device_id: ownerDeviceId, status: "lobby", settings })
      .select("*")
      .maybeSingle();
    if (data) return { room: rowToRoom(data as RoomRow), ownerToken };
    if (error && error.code !== "23505") {
      throw new Error(`failed to create room: ${error.message}`);
    }
  }
  throw new Error("could not allocate a unique room code");
}

// Hosts report their roster on a short timer, so a report older than this means the host's tab
// is gone (closed, slept, or offline) and the room should stop being advertised. Kept a few
// times the report interval so one dropped request does not flicker a live room off the list.
const OCCUPANCY_STALE_MS = 45 * 1000;

// How many recent lobbies to inspect when building the list. Each is read back through
// getRoom (base row + jobs overlay), so this bounds the reads one page load costs.
const JOINABLE_CANDIDATE_LIMIT = 25;

/** A room as the browser page shows it: enough to decide whether to walk in. */
export interface OpenRoom {
  code: string;
  trackId: string;
  laps: number;
  maxPlayers: number;
  players: number;
  createdAt: number;
}

/**
 * Rooms a player could walk into right now: still in the lobby, not full, and with a host that
 * has reported in recently. A room whose host stopped reporting is treated as abandoned —
 * better to hide a live room briefly than to send someone into an empty one.
 */
export async function listOpenRooms(limit = 20): Promise<OpenRoom[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("rooms")
    .select("code")
    .eq("status", "lobby")
    .order("updated_at", { ascending: false })
    .limit(JOINABLE_CANDIDATE_LIMIT);
  if (error) throw new Error(`failed to list rooms: ${error.message}`);
  const codes = ((data ?? []) as { code: string }[]).map((row) => row.code);
  if (codes.length === 0) return [];

  // Occupancy first, in one query, so the expensive per-room read below only runs for rooms
  // that could actually be listed. Most candidates are abandoned lobbies nobody reported on.
  const { data: reports, error: reportError } = await client
    .from("jobs")
    .select("id, data")
    .in("id", codes.map(occupancyRowId));
  if (reportError) throw new Error(`failed to read occupancy: ${reportError.message}`);

  const now = Date.now();
  const occupancy = new Map<string, RoomOccupancy>();
  for (const row of (reports ?? []) as { id: string; data: unknown }[]) {
    const parsed = parseOccupancy(row.data);
    if (!parsed || parsed.players <= 0) continue;
    if (now - parsed.at > OCCUPANCY_STALE_MS) continue;
    occupancy.set(row.id.slice(occupancyRowId("").length), parsed);
  }
  if (occupancy.size === 0) return [];

  // The base row's `status` can be stale — a room that has started a race keeps `lobby` there
  // until the overlay is applied — so the rooms that got this far are still read in full.
  const rooms = await Promise.all([...occupancy.keys()].map((code) => getRoom(code)));
  return rooms
    .filter((room): room is Room => Boolean(room))
    .filter((room) => room.status === "lobby")
    .map((room) => ({ room, players: occupancy.get(room.code)!.players }))
    .filter(({ room, players }) => players < room.settings.maxPlayers)
    .sort((a, b) => b.players - a.players)
    .slice(0, limit)
    .map(({ room, players }) => ({
      code: room.code,
      trackId: room.settings.trackId,
      laps: room.settings.laps,
      maxPlayers: room.settings.maxPlayers,
      players,
      createdAt: room.createdAt,
    }));
}

/**
 * Record what the host sees. Deliberately off the revision chain: this fires on a timer and
 * bumping the revision would invalidate every client's settings CAS several times a minute.
 */
export async function reportRoomOccupancy(code: string, players: number): Promise<void> {
  const { error } = await getServiceClient()
    .from("jobs")
    .upsert({
      id: occupancyRowId(code),
      data: { players, at: Date.now() } satisfies RoomOccupancy,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`failed to report occupancy: ${error.message}`);
}

export async function getRoom(code: string): Promise<Room | undefined> {
  const { data, error } = await getServiceClient()
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(`failed to read room: ${error.message}`);
  if (!data) return undefined;

  // The deployed database grants immutable inserts but may not grant UPDATE on rooms.
  // Store mutations as revision-keyed events in the existing jobs table, then overlay the
  // latest event. A deterministic event id makes concurrent writes true compare-and-swap.
  //
  // "Latest" means the highest revision, not the most recent timestamp. Ordering by the clock
  // let a stale event win whenever two writes landed close together or a clock stepped, and
  // the room then silently reverted a transition — a room that had just been reset to the
  // lobby would read as `racing` again and throw everyone back into the race they had
  // finished. The revision is the only thing that actually defines the order here.
  const { data: eventData, error: eventError } = await getServiceClient()
    .from("jobs")
    .select("id, data, updated_at")
    .like("id", `room-state:${code}:%`)
    .order("updated_at", { ascending: false })
    .limit(OVERLAY_SCAN_LIMIT);
  if (eventError) throw new Error(`failed to read room state: ${eventError.message}`);
  const event = latestRoomEvent((eventData ?? []) as RoomEventRow[]);
  if (!event) return rowToRoom(data as RoomRow);

  const base = data as RoomRow;
  const status = event.data?.status;
  if (status !== "lobby" && status !== "racing" && status !== "finished") {
    return rowToRoom(base);
  }
  return rowToRoom({
    ...base,
    status,
    settings: event.data.settings,
    updated_at: event.updated_at,
  });
}

/**
 * How many recent state events to inspect. Only the highest revision matters, and writes are
 * serialised by the CAS, so a handful is always enough to contain the winner.
 */
const OVERLAY_SCAN_LIMIT = 10;

function eventRevision(id: string): number {
  const revision = Number.parseInt(id.slice(id.lastIndexOf(":") + 1), 10);
  return Number.isInteger(revision) ? revision : -1;
}

function latestRoomEvent(rows: RoomEventRow[]): RoomEventRow | null {
  let best: RoomEventRow | null = null;
  for (const row of rows) {
    if (!best || eventRevision(row.id) > eventRevision(best.id)) best = row;
  }
  return best;
}

async function casUpdate(
  room: Room,
  patch: { settings: RaceSettings; race: RaceSnapshot | null; status: RoomStatus },
): Promise<Room | undefined> {
  if (room.revision < 0) return undefined;
  const settings = storedSettings(room, patch.settings, patch.race);
  const { data, error } = await getServiceClient()
    .from("jobs")
    .insert({
      id: `room-state:${room.code}:${room.revision + 1}`,
      data: { status: patch.status, settings },
    })
    .select("id, data, updated_at")
    .maybeSingle();
  if (error?.code === "23505") return undefined;
  if (error) throw new Error(`failed to update room: ${error.message}`);
  if (!data) return undefined;
  const event = data as RoomEventRow;
  return rowToRoom({
    code: room.code,
    owner_device_id: room.ownerDeviceId,
    status: patch.status,
    settings: event.data.settings,
    created_at: new Date(room.createdAt).toISOString(),
    updated_at: event.updated_at,
  });
}

export async function updateRoomSettings(
  room: Room,
  settings: RaceSettings,
): Promise<Room | undefined> {
  if (room.status !== "lobby") return undefined;
  return casUpdate(room, { settings, race: null, status: "lobby" });
}

export async function startRoomRace(
  room: Room,
  race: RaceSnapshot,
): Promise<Room | undefined> {
  if (room.status !== "lobby") return undefined;
  return casUpdate(room, { settings: room.settings, race, status: "racing" });
}

/**
 * Close a race out. Without this the room stays `racing` forever after the last car crosses
 * the line, and anything that keys off status keeps treating a race that is over as live —
 * most visibly, opening the room link drops the arrival straight back into the finished race.
 *
 * Guarded by raceId, not just by CAS: two clients calling this for the same race is expected
 * (the owner may have several tabs), while a call naming an older race is stale and must not
 * end the one now running.
 */
export async function finishRoomRace(room: Room, raceId: string): Promise<Room | undefined> {
  if (room.status !== "racing" || room.race?.raceId !== raceId) return undefined;
  return casUpdate(room, { settings: room.settings, race: room.race, status: "finished" });
}

export async function resetRoomToLobby(room: Room): Promise<Room | undefined> {
  if (room.status !== "racing" && room.status !== "finished") return undefined;
  return casUpdate(room, { settings: room.settings, race: null, status: "lobby" });
}
