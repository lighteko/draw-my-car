import { getServiceClient } from "@/lib/supabase";
import { DEFAULT_SETTINGS, type RaceSettings } from "@/lib/roomTypes";

/**
 * rooms.ts - racing rooms (Supabase only; rooms are meaningless without Realtime).
 *
 * The row exists so a share-link cold load can render the lobby with current settings
 * before the channel syncs. Membership itself is ephemeral (Realtime presence).
 */

export type RoomStatus = "lobby" | "racing" | "finished";

export interface Room {
  code: string;
  ownerDeviceId: string;
  status: RoomStatus;
  settings: RaceSettings;
  createdAt: number;
  updatedAt: number;
}

interface RoomRow {
  code: string;
  owner_device_id: string;
  status: RoomStatus;
  settings: RaceSettings;
  created_at: string;
  updated_at: string;
}

function rowToRoom(r: RoomRow): Room {
  return {
    code: r.code,
    ownerDeviceId: r.owner_device_id,
    status: r.status,
    settings: r.settings,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}

// Unambiguous alphabet (no 0/o/1/l/i).
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function genCode(len = 5): string {
  let code = "";
  for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}

export async function createRoom(ownerDeviceId: string): Promise<Room> {
  const client = getServiceClient();
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = genCode();
    const { data, error } = await client
      .from("rooms")
      .insert({
        code,
        owner_device_id: ownerDeviceId,
        status: "lobby",
        settings: DEFAULT_SETTINGS,
      })
      .select("*")
      .maybeSingle();
    if (data) return rowToRoom(data as RoomRow);
    // 23505 = unique_violation → collided code, retry.
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
  return data ? rowToRoom(data as RoomRow) : undefined;
}

export async function updateRoom(
  code: string,
  patch: { settings?: RaceSettings; status?: RoomStatus },
): Promise<Room | undefined> {
  const { data, error } = await getServiceClient()
    .from("rooms")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("code", code)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`failed to update room: ${error.message}`);
  return data ? rowToRoom(data as RoomRow) : undefined;
}
