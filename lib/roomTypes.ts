/**
 * roomTypes.ts — shared shapes for lobby + racing (client and server).
 *
 * Broadcast traffic uses a single Realtime event ("msg") carrying a RoomMessage that is
 * dispatched on `kind`. New message kinds are added here as later phases need them.
 */

export type RaceType = "circuit";

export interface RaceSettings {
  /** An admin map id, or "random" (resolved by the host at race start). */
  trackId: string;
  raceType: RaceType;
  laps: number;
  maxPlayers: number;
}

export const DEFAULT_SETTINGS: RaceSettings = {
  trackId: "random",
  raceType: "circuit",
  laps: 1,
  maxPlayers: 8,
};

// One lap by default, two at most: a lap of the Jericho map is ~2.2 km, which is already
// close to three minutes of driving — more than that stops being a pick-up-and-play race.
export const LAP_OPTIONS = [1, 2] as const;
export const MAX_PLAYER_OPTIONS = [2, 4, 6, 8] as const;

export type Role = "player" | "spectator";

/** One participant, carried in Realtime presence. */
export interface PresenceMeta {
  deviceId: string;
  /** Per-tab identity so overlapping reconnects do not preserve stale ready state. */
  sessionId: string;
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

/** Immutable server-persisted configuration for one running race. */
export interface RaceSnapshot {
  raceId: string;
  trackId: string;
  laps: number;
  grid: GridSlot[];
  startAt: number;
  createdAt: number;
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
  | { kind: "room_changed"; version: string }
  | { kind: "player_state"; member: PresenceMeta }
  // High-frequency car pose (kept out of React state; buffered + interpolated).
  | {
      kind: "transform";
      raceId: string;
      senderDeviceId: string;
      deviceId: string;
      p: Vec3n;
      q: Quat;
    }
  // A player's own lap progress, reported to the owner for ranking.
  | {
      kind: "progress";
      raceId: string;
      senderDeviceId: string;
      deviceId: string;
      lap: number;
      nextGate: number;
    }
  | {
      kind: "finished";
      raceId: string;
      senderDeviceId: string;
      deviceId: string;
      lap: number;
      nextGate: number;
      totalMs: number;
      /** Fastest single lap of this race, which is what the global board ranks. */
      bestLapMs: number;
    }
  | { kind: "progress_request"; raceId: string; senderDeviceId: string }
  | {
      kind: "progress_state";
      raceId: string;
      senderDeviceId: string;
      deviceId: string;
      lap: number;
      nextGate: number;
      finished: boolean;
      totalMs: number | null;
    }
  // Owner-authoritative leaderboard, rebroadcast to everyone.
  | { kind: "standings"; raceId: string; senderDeviceId: string; entries: Standing[] };
