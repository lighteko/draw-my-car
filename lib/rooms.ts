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
