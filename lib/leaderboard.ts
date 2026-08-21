import { getServiceClient } from "@/lib/supabase";

/**
 * leaderboard.ts — every player's best lap, across every race the game has run.
 *
 * Stored as keyed rows in the existing `jobs` table, the same store rooms use for their state
 * events. That is a deliberate constraint rather than a preference: the deployed schema is
 * applied by hand, so shipping a feature that needs a new table means shipping something that
 * is broken until someone remembers to run the SQL.
 *
 * One row per (track, device) holding only that player's best. A record that cannot be beaten
 * is never written again, so the store grows with the number of players and maps rather than
 * with the number of races — which is also what keeps the scan below bounded.
 */

/** A lap under this is not a lap, it is a mis-registered gate; over it, an abandoned tab. */
const MIN_LAP_MS = 3_000;
const MAX_LAP_MS = 60 * 60 * 1000;

/**
 * Ceiling on rows read for one board. Well past players x maps for a game this size; if it is
 * ever reached the board silently shows the first N, so it is worth revisiting before then.
 */
const SCAN_LIMIT = 2000;

export interface LapRecord {
  deviceId: string;
  username: string;
  trackId: string;
  lapMs: number;
  /** Epoch ms the record was set, so ties break toward whoever got there first. */
  at: number;
}

export interface LapRecordInput {
  deviceId: string;
  username: string;
  trackId: string;
  lapMs: number;
}

function recordRowId(trackId: string, deviceId: string): string {
  return `lap-record:${trackId}:${deviceId}`;
}

function parseLapRecord(value: unknown): LapRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { deviceId, username, trackId, lapMs, at } = value as Record<string, unknown>;
  if (typeof deviceId !== "string" || deviceId.length === 0) return null;
  if (typeof trackId !== "string" || trackId.length === 0) return null;
  if (typeof lapMs !== "number" || !Number.isFinite(lapMs)) return null;
  if (lapMs < MIN_LAP_MS || lapMs > MAX_LAP_MS) return null;
  return {
    deviceId,
    username: typeof username === "string" && username.length > 0 ? username : "이름 없는 주자",
    trackId,
    lapMs,
    at: Number.isFinite(at) ? (at as number) : 0,
  };
}

/** Whether a claimed lap is worth storing at all. Rejected times are dropped, not clamped. */
export function isPlausibleLap(lapMs: unknown): lapMs is number {
  return typeof lapMs === "number" && Number.isFinite(lapMs) && lapMs >= MIN_LAP_MS && lapMs <= MAX_LAP_MS;
}

/**
 * Store these laps, keeping each player's best per track.
 *
 * Read-then-write rather than a blind upsert, because a slower lap must not overwrite a
 * standing record. The two can interleave — the same player finishing two races at once is
 * not a real scenario, and the worst case is a record surviving one race longer than it
 * should — so this stays a plain compare rather than something that needs a transaction.
 */
export async function recordLapTimes(entries: LapRecordInput[]): Promise<void> {
  const best = new Map<string, LapRecordInput>();
  for (const entry of entries) {
    if (!isPlausibleLap(entry.lapMs)) continue;
    const key = recordRowId(entry.trackId, entry.deviceId);
    const existing = best.get(key);
    if (!existing || entry.lapMs < existing.lapMs) best.set(key, entry);
  }
  if (best.size === 0) return;

  const client = getServiceClient();
  const { data, error } = await client
    .from("jobs")
    .select("id, data")
    .in("id", [...best.keys()]);
  if (error) throw new Error(`failed to read lap records: ${error.message}`);

  const current = new Map<string, LapRecord>();
  for (const row of (data ?? []) as { id: string; data: unknown }[]) {
    const parsed = parseLapRecord(row.data);
    if (parsed) current.set(row.id, parsed);
  }

  const now = Date.now();
  const rows = [...best.entries()]
    .filter(([id, entry]) => {
      const held = current.get(id);
      return !held || entry.lapMs < held.lapMs;
    })
    .map(([id, entry]) => ({
      id,
      data: { ...entry, at: now } satisfies LapRecord,
      updated_at: new Date(now).toISOString(),
    }));
  if (rows.length === 0) return;

  const { error: writeError } = await client.from("jobs").upsert(rows);
  if (writeError) throw new Error(`failed to write lap records: ${writeError.message}`);
}

/**
 * The board, fastest first. `trackId` narrows it to one map.
 *
 * Sorting happens here rather than in the query: the times live inside a JSON column, where
 * ordering would be lexicographic and would rank 9s ahead of 10s.
 */
export async function listLapRecords(trackId?: string): Promise<LapRecord[]> {
  const { data, error } = await getServiceClient()
    .from("jobs")
    .select("data")
    .like("id", trackId ? `lap-record:${trackId}:%` : "lap-record:%")
    .limit(SCAN_LIMIT);
  if (error) throw new Error(`failed to list lap records: ${error.message}`);

  return ((data ?? []) as { data: unknown }[])
    .map((row) => parseLapRecord(row.data))
    .filter((record): record is LapRecord => record !== null)
    .sort((a, b) => a.lapMs - b.lapMs || a.at - b.at);
}
