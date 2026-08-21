"use client";

/**
 * soloRecords.ts — personal bests from practice runs.
 *
 * Kept in localStorage rather than on the server, and deliberately never merged into the
 * global board. A solo lap is timed entirely by the client with nothing to check it against —
 * no server-issued start, no other cars — so it is a note to yourself about your own driving,
 * not a claim about where you stand. Treating it as the latter would put an unverifiable
 * number next to verified ones.
 */

const KEY = "dmc_solo_pb";

export interface SoloRecord {
  trackId: string;
  lapMs: number;
  /** Epoch ms it was set, so the page can say how long a record has stood. */
  at: number;
}

function readAll(): Record<string, SoloRecord> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, SoloRecord> = {};
    for (const [trackId, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) continue;
      const { lapMs, at } = value as { lapMs?: unknown; at?: unknown };
      if (typeof lapMs !== "number" || !Number.isFinite(lapMs) || lapMs <= 0) continue;
      out[trackId] = { trackId, lapMs, at: Number.isFinite(at) ? (at as number) : 0 };
    }
    return out;
  } catch {
    // Corrupt or blocked storage: an empty history beats a crashed garage.
    return {};
  }
}

export function listSoloRecords(): SoloRecord[] {
  return Object.values(readAll()).sort((a, b) => b.at - a.at);
}

export function getSoloRecord(trackId: string): SoloRecord | null {
  return readAll()[trackId] ?? null;
}

/** Store a lap if it beats this track's best. Returns true when it was a new record. */
export function recordSoloLap(trackId: string, lapMs: number): boolean {
  if (!Number.isFinite(lapMs) || lapMs <= 0) return false;
  const all = readAll();
  const held = all[trackId];
  if (held && held.lapMs <= lapMs) return false;
  all[trackId] = { trackId, lapMs, at: Date.now() };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    return false;
  }
  return true;
}

/** mm:ss.hh, or ss.hh under a minute — the format lap times are read in. */
export function formatLap(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  const pad = (value: number) => String(value).padStart(2, "0");
  return minutes > 0 ? `${minutes}:${pad(seconds)}.${pad(hundredths)}` : `${seconds}.${pad(hundredths)}`;
}
