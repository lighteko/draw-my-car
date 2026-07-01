/**
 * roomTypes.ts — shared shapes for lobby + racing (client and server).
 *
 * Broadcast traffic uses a single Realtime event ("msg") carrying a RoomMessage that is
 * dispatched on `kind`. New message kinds are added here as later phases need them.
 */

export type RaceType = "circuit";

export interface RaceSettings {
  /** A TRACK id, or "random" (resolved at race start). */
  trackId: string;
  raceType: RaceType;
  laps: number;
  maxPlayers: number;
}

export const DEFAULT_SETTINGS: RaceSettings = {
  trackId: "random",
  raceType: "circuit",
  laps: 3,
  maxPlayers: 8,
};

export const LAP_OPTIONS = [1, 2, 3, 5] as const;
export const MAX_PLAYER_OPTIONS = [2, 4, 6, 8] as const;

export type Role = "player" | "spectator";

/** One participant, carried in Realtime presence. */
export interface PresenceMeta {
  deviceId: string;
  username: string;
  role: Role;
  carId: string | null;
  /** The chosen car's name, so the roster can show it without the owner's garage. */
  carName: string | null;
  ready: boolean;
}

export interface GridSlot {
  deviceId: string;
  slot: number;
}

export type RoomMessage =
  | { kind: "settings"; settings: RaceSettings }
  | { kind: "start"; trackId: string; laps: number; grid: GridSlot[]; startAt: number };
