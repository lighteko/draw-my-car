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
