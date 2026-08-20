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
  /** Player count last reported by the host, or null if it never reported. */
  occupancy: RoomOccupancy | null;
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
  occupancy?: RoomOccupancy | null;
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
    occupancy: parseOccupancy(meta?.occupancy),
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
 * on screen — reports it. One writer means no read-modify-write races over the JSON blob, and
 * a room whose host has gone quiet simply ages out of the browser, which is the behaviour we
 * wanted anyway.
 */
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
      occupancy: room.occupancy,
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
  if (!data || data.length === 0) return [];

  const now = Date.now();
  const rooms = await Promise.all((data as { code: string }[]).map((row) => getRoom(row.code)));
  return rooms
    .filter((room): room is Room => Boolean(room))
    .filter((room) => room.status === "lobby")
    .filter((room) => room.occupancy !== null && now - room.occupancy.at <= OCCUPANCY_STALE_MS)
    .filter((room) => room.occupancy!.players > 0)
    .filter((room) => room.occupancy!.players < room.settings.maxPlayers)
    .sort((a, b) => (b.occupancy?.players ?? 0) - (a.occupancy?.players ?? 0))
    .slice(0, limit)
    .map((room) => ({
      code: room.code,
      trackId: room.settings.trackId,
      laps: room.settings.laps,
      maxPlayers: room.settings.maxPlayers,
      players: room.occupancy?.players ?? 0,
      createdAt: room.createdAt,
    }));
}

/**
 * Record what the host sees. Deliberately does not bump `revision`: this fires on a timer and
 * would otherwise invalidate every client's settings CAS several times a minute.
 */
export async function reportRoomOccupancy(
  room: Room,
  players: number,
): Promise<Room | undefined> {
  const client = getServiceClient();
  const next: Room = { ...room, occupancy: { players, at: Date.now() } };
  const { data, error } = await client
    .from("rooms")
    .update({ settings: storedSettings(next, room.settings, room.race, room.revision) })
    .eq("code", room.code)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`failed to report occupancy: ${error.message}`);
  return data ? rowToRoom(data as RoomRow) : undefined;
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
  const { data: eventData, error: eventError } = await getServiceClient()
    .from("jobs")
    .select("data, updated_at")
    .like("id", `room-state:${code}:%`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (eventError) throw new Error(`failed to read room state: ${eventError.message}`);
  if (!eventData) return rowToRoom(data as RoomRow);

  const base = data as RoomRow;
  const event = eventData as RoomEventRow;
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
    .select("data, updated_at")
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

export async function resetRoomToLobby(room: Room): Promise<Room | undefined> {
  if (room.status !== "racing" && room.status !== "finished") return undefined;
  return casUpdate(room, { settings: room.settings, race: null, status: "lobby" });
}
