import { getServiceClient, hasSupabase } from "@/lib/supabase";

/**
 * players.ts — server-side player upsert.
 *
 * Any route that creates a row referencing a player (e.g. cars.owner_device_id) calls this
 * first so the parent row always exists, independent of the client's best-effort
 * ensurePlayer(). No-op when Supabase isn't configured.
 */

export interface PlayerRow {
  deviceId: string;
  username: string | null;
}

export async function upsertPlayer(deviceId: string, username?: string | null): Promise<PlayerRow> {
  if (!hasSupabase()) return { deviceId, username: username ?? null };

  const payload: Record<string, unknown> = {
    device_id: deviceId,
    last_seen: new Date().toISOString(),
  };
  if (username) payload.username = username;

  const { data, error } = await getServiceClient()
    .from("players")
    .upsert(payload, { onConflict: "device_id" })
    .select("device_id, username")
    .single();

  if (error) throw new Error(`failed to upsert player: ${error.message}`);
  return { deviceId: data.device_id, username: data.username };
}

/**
 * Display names for a set of devices, as the player set them.
 *
 * The global board reads names from here rather than from whoever reported the race: the
 * report is made by one player on everyone's behalf, and a public board is not something the
 * reporter should get to write other people's names onto.
 */
export async function getUsernames(deviceIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!hasSupabase() || deviceIds.length === 0) return names;

  const { data, error } = await getServiceClient()
    .from("players")
    .select("device_id, username")
    .in("device_id", deviceIds);
  if (error) throw new Error(`failed to read usernames: ${error.message}`);

  for (const row of (data ?? []) as { device_id: string; username: string | null }[]) {
    if (row.username) names.set(row.device_id, row.username);
  }
  return names;
}
