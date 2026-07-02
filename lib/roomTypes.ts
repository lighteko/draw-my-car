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

export type Vec3n = [number, number, number];
export type Quat = [number, number, number, number];

/** A row in the live leaderboard, ranked by the owner. */
export interface Standing {
  deviceId: string;
  username: string;
  carName: string | null;
  lap: number;
  /** lap * gateCount + gate progress — a monotonic distance for ranking. */
  progress: number;
  finished: boolean;
  totalMs: number | null;
}

export type RoomMessage =
  | { kind: "settings"; settings: RaceSettings }
  | { kind: "start"; trackId: string; laps: number; grid: GridSlot[]; startAt: number }
  // High-frequency car pose (kept out of React state; buffered + interpolated).
  | { kind: "transform"; deviceId: string; p: Vec3n; q: Quat }
  // A player's own lap progress, reported to the owner for ranking.
  | { kind: "progress"; deviceId: string; lap: number; nextGate: number }
  | { kind: "finished"; deviceId: string; totalMs: number }
  // Owner-authoritative leaderboard, rebroadcast to everyone.
  | { kind: "standings"; entries: Standing[] };
