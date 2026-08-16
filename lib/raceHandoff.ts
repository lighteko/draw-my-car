import type { GridSlot } from "./roomTypes";

/**
 * raceHandoff.ts — carries the owner-resolved race config across the lobby → race
 * navigation (and across mid-race reloads; sessionStorage survives both in the same tab).
 *
 * The lobby owner assigns the grid exactly once from the full roster; every client
 * persists it here before navigating so the race page never has to re-derive spawn
 * slots from a partial presence sync (which is what used to put everyone in slot 0).
 */

export interface RaceHandoff {
  raceId: string;
  trackId: string;
  laps: number;
  /** Owner-assigned spawn slots, one per player, unique by construction. */
  grid: GridSlot[];
  ownerDeviceId: string;
  /** Server-issued shared wall-clock start. */
  startAt: number;
}

const key = (code: string) => `dmc_race:${code}`;

export function saveRaceHandoff(code: string, handoff: RaceHandoff): void {
  try {
    window.sessionStorage.setItem(key(code), JSON.stringify(handoff));
  } catch {
    /* storage full/blocked — the race page falls back to the room API */
  }
}

export function loadRaceHandoff(code: string): RaceHandoff | null {
  try {
    const raw = window.sessionStorage.getItem(key(code));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RaceHandoff;
    if (
      !parsed ||
      typeof parsed.raceId !== "string" ||
      typeof parsed.trackId !== "string" ||
      !Array.isArray(parsed.grid) ||
      !Number.isFinite(parsed.startAt)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
