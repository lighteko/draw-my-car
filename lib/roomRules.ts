import {
  LAP_OPTIONS,
  MAX_PLAYER_OPTIONS,
  type GridSlot,
  type PresenceMeta,
  type RoomMessage,
  type RaceSettings,
  type RaceSnapshot,
  type Standing,
} from "./roomTypes";

const SETTINGS_KEYS = ["trackId", "raceType", "laps", "maxPlayers"] as const;
const SNAPSHOT_KEYS = ["raceId", "trackId", "laps", "grid", "startAt", "createdAt"] as const;
const GRID_SLOT_KEYS = ["deviceId", "slot"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function isTrackId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.trim().length > 0
  );
}

function isRaceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    value.trim().length > 0
  );
}

function isLapOption(value: unknown): value is RaceSettings["laps"] {
  return typeof value === "number" && (LAP_OPTIONS as readonly number[]).includes(value);
}

function isMaxPlayerOption(value: unknown): value is RaceSettings["maxPlayers"] {
  return typeof value === "number" && (MAX_PLAYER_OPTIONS as readonly number[]).includes(value);
}

/** Parse untrusted room settings, rejecting missing, unknown, or invalid fields. */
export function parseRaceSettings(value: unknown): RaceSettings | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)) return null;
    if (!isTrackId(value.trackId)) return null;
    if (value.raceType !== "circuit") return null;
    if (!isLapOption(value.laps)) return null;
    if (!isMaxPlayerOption(value.maxPlayers)) return null;

    return {
      trackId: value.trackId,
      raceType: value.raceType,
      laps: value.laps,
      maxPlayers: value.maxPlayers,
    };
  } catch {
    return null;
  }
}

export function isRaceSettings(value: unknown): value is RaceSettings {
  return parseRaceSettings(value) !== null;
}

/**
 * Assign deterministic, contiguous grid slots. Invalid admission input is rejected instead
 * of being silently truncated, so every caller observes the same roster.
 */
export function createGrid(deviceIds: readonly string[], maxPlayers: number): GridSlot[] {
  if (!Number.isInteger(maxPlayers) || maxPlayers < 0) {
    throw new Error("maxPlayers must be a non-negative integer");
  }
  if (deviceIds.length > maxPlayers) {
    throw new Error("player count exceeds maxPlayers");
  }

  const seen = new Set<string>();
  return deviceIds.map((deviceId, slot) => {
    if (
      typeof deviceId !== "string" ||
      deviceId.length > 256 ||
      deviceId.trim().length === 0
    ) {
      throw new Error("device ids must be non-empty strings");
    }
    if (seen.has(deviceId)) throw new Error("device ids must be unique");
    seen.add(deviceId);
    return { deviceId, slot };
  });
}

function parseGrid(value: unknown): GridSlot[] | null {
  if (!Array.isArray(value)) return null;

  const deviceIds = new Set<string>();
  const slots = new Set<number>();
  const grid: GridSlot[] = [];

  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, GRID_SLOT_KEYS)) return null;
    if (
      typeof entry.deviceId !== "string" ||
      entry.deviceId.length > 256 ||
      entry.deviceId.trim().length === 0
    ) {
      return null;
    }
    if (!Number.isInteger(entry.slot) || (entry.slot as number) < 0) return null;
    if (deviceIds.has(entry.deviceId) || slots.has(entry.slot as number)) return null;

    deviceIds.add(entry.deviceId);
    slots.add(entry.slot as number);
    grid.push({ deviceId: entry.deviceId, slot: entry.slot as number });
  }

  if ([...slots].some((slot) => slot >= grid.length)) return null;
  return grid;
}

/** Parse an untrusted persisted race snapshot and return a detached validated value. */
export function parseRaceSnapshot(value: unknown): RaceSnapshot | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return null;
    if (!isRaceId(value.raceId) || !isTrackId(value.trackId) || !isLapOption(value.laps)) {
      return null;
    }
    const grid = parseGrid(value.grid);
    if (!grid || grid.length === 0) return null;
    if (typeof value.startAt !== "number" || !Number.isFinite(value.startAt) || value.startAt <= 0) {
      return null;
    }
    if (
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      value.createdAt <= 0
    ) {
      return null;
    }
    if (value.startAt < (value.createdAt as number)) return null;

    return {
      raceId: value.raceId,
      trackId: value.trackId,
      laps: value.laps,
      grid,
      startAt: value.startAt,
      createdAt: value.createdAt,
    };
  } catch {
    return null;
  }
}

export function isRaceSnapshot(value: unknown): value is RaceSnapshot {
  return parseRaceSnapshot(value) !== null;
}

/** Resolve a device's authoritative slot, or null when it is not admitted to this race. */
export function gridMembership(
  source: RaceSnapshot | readonly GridSlot[],
  deviceId: string,
): GridSlot | null {
  const grid: readonly GridSlot[] = Array.isArray(source)
    ? (source as readonly GridSlot[])
    : (source as RaceSnapshot).grid;
  return grid.find((entry) => entry.deviceId === deviceId) ?? null;
}

const PRESENCE_KEYS = [
  "deviceId",
  "sessionId",
  "username",
  "role",
  "carId",
  "carName",
  "ready",
] as const;
const STANDING_KEYS = [
  "deviceId",
  "username",
  "carName",
  "lap",
  "progress",
  "finished",
  "totalMs",
] as const;

function isBoundedString(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    value.trim().length > 0
  );
}

export interface ProgressPoint {
  lap: number;
  nextGate: number;
}

/** Monotonic race distance used both for ranking and stale progress rejection. */
export function progressScore(progress: ProgressPoint, gateCount: number): number {
  const count = gateCount || 1;
  return progress.lap * count + ((progress.nextGate - 1 + count) % count);
}

/** Accept idempotent duplicates and forward movement, but reject invalid or stale progress. */
export function isProgressUpdateAllowed(
  current: ProgressPoint,
  next: ProgressPoint,
  gateCount: number,
  maxLaps: number,
): boolean {
  const count = Math.max(gateCount, 1);
  return (
    Number.isInteger(next.lap) &&
    next.lap >= 0 &&
    next.lap <= maxLaps &&
    Number.isInteger(next.nextGate) &&
    next.nextGate >= 0 &&
    next.nextGate < count &&
    progressScore(next, gateCount) >= progressScore(current, gateCount)
  );
}

export type RaceScopedRoomMessage = Exclude<
  RoomMessage,
  { kind: "room_changed" } | { kind: "player_state" }
>;

/** Narrow an already parsed payload to the currently active immutable race. */
export function isRoomMessageForRace(
  message: RoomMessage,
  activeRaceId: string,
): message is RaceScopedRoomMessage {
  return "raceId" in message && message.raceId === activeRaceId;
}

function parsePresence(value: unknown): PresenceMeta | null {
  if (!isRecord(value) || !hasExactKeys(value, PRESENCE_KEYS)) return null;
  if (
    !isBoundedString(value.deviceId) ||
    !isBoundedString(value.sessionId) ||
    typeof value.username !== "string" ||
    value.username.length > 80 ||
    (value.role !== "player" && value.role !== "spectator") ||
    (value.carId !== null && !isBoundedString(value.carId)) ||
    (value.carName !== null && (typeof value.carName !== "string" || value.carName.length > 120)) ||
    typeof value.ready !== "boolean"
  ) {
    return null;
  }
  return value as unknown as PresenceMeta;
}

function parseStanding(value: unknown): Standing | null {
  if (!isRecord(value) || !hasExactKeys(value, STANDING_KEYS)) return null;
  if (
    !isBoundedString(value.deviceId) ||
    typeof value.username !== "string" ||
    value.username.length > 80 ||
    (value.carName !== null && (typeof value.carName !== "string" || value.carName.length > 120)) ||
    !Number.isInteger(value.lap) ||
    (value.lap as number) < 0 ||
    typeof value.progress !== "number" ||
    !Number.isFinite(value.progress) ||
    value.progress < 0 ||
    typeof value.finished !== "boolean" ||
    (value.totalMs !== null &&
      (typeof value.totalMs !== "number" || !Number.isFinite(value.totalMs) || value.totalMs < 0))
  ) {
    return null;
  }
  return value as unknown as Standing;
}

function isTuple(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

/** Runtime boundary for public Realtime payloads. Unknown or malformed events are ignored. */
export function parseRoomMessage(value: unknown): RoomMessage | null {
  try {
    if (!isRecord(value) || typeof value.kind !== "string") return null;
    switch (value.kind) {
      case "room_changed":
        return hasExactKeys(value, ["kind", "version"]) && isBoundedString(value.version)
          ? (value as unknown as RoomMessage)
          : null;
      case "player_state": {
        const member = parsePresence(value.member);
        return hasExactKeys(value, ["kind", "member"]) && member
          ? { kind: "player_state", member }
          : null;
      }
      case "transform":
        return hasExactKeys(value, [
          "kind",
          "raceId",
          "senderDeviceId",
          "deviceId",
          "p",
          "q",
        ]) &&
          isBoundedString(value.raceId) &&
          isBoundedString(value.senderDeviceId) &&
          isBoundedString(value.deviceId) &&
          value.senderDeviceId === value.deviceId &&
          isTuple(value.p, 3) &&
          isTuple(value.q, 4)
          ? (value as unknown as RoomMessage)
          : null;
      case "progress":
        return hasExactKeys(value, [
          "kind",
          "raceId",
          "senderDeviceId",
          "deviceId",
          "lap",
          "nextGate",
        ]) &&
          isBoundedString(value.raceId) &&
          isBoundedString(value.senderDeviceId) &&
          isBoundedString(value.deviceId) &&
          Number.isInteger(value.lap) &&
          (value.lap as number) >= 0 &&
          Number.isInteger(value.nextGate) &&
          (value.nextGate as number) >= 0 &&
          value.senderDeviceId === value.deviceId
          ? (value as unknown as RoomMessage)
          : null;
      case "finished":
        return hasExactKeys(value, [
          "kind",
          "raceId",
          "senderDeviceId",
          "deviceId",
          "lap",
          "nextGate",
          "totalMs",
        ]) &&
          isBoundedString(value.raceId) &&
          isBoundedString(value.senderDeviceId) &&
          isBoundedString(value.deviceId) &&
          value.senderDeviceId === value.deviceId &&
          Number.isInteger(value.lap) &&
          (value.lap as number) >= 0 &&
          Number.isInteger(value.nextGate) &&
          (value.nextGate as number) >= 0 &&
          typeof value.totalMs === "number" &&
          Number.isFinite(value.totalMs) &&
          value.totalMs >= 0
          ? (value as unknown as RoomMessage)
          : null;
      case "progress_request":
        return hasExactKeys(value, ["kind", "raceId", "senderDeviceId"]) &&
          isBoundedString(value.raceId) &&
          isBoundedString(value.senderDeviceId)
          ? (value as unknown as RoomMessage)
          : null;
      case "progress_state":
        return hasExactKeys(value, [
          "kind",
          "raceId",
          "senderDeviceId",
          "deviceId",
          "lap",
          "nextGate",
          "finished",
          "totalMs",
        ]) &&
          isBoundedString(value.raceId) &&
          isBoundedString(value.senderDeviceId) &&
          isBoundedString(value.deviceId) &&
          Number.isInteger(value.lap) &&
          (value.lap as number) >= 0 &&
          Number.isInteger(value.nextGate) &&
          (value.nextGate as number) >= 0 &&
          value.senderDeviceId === value.deviceId &&
          typeof value.finished === "boolean" &&
          (value.totalMs === null ||
            (typeof value.totalMs === "number" && Number.isFinite(value.totalMs) && value.totalMs >= 0))
          ? (value as unknown as RoomMessage)
          : null;
      case "standings": {
        if (
          !hasExactKeys(value, ["kind", "raceId", "senderDeviceId", "entries"]) ||
          !isBoundedString(value.raceId) ||
          !isBoundedString(value.senderDeviceId) ||
          !Array.isArray(value.entries) ||
          value.entries.length > 64
        ) {
          return null;
        }
        const entries = value.entries.map(parseStanding);
        if (!entries.every((entry): entry is Standing => entry !== null)) return null;
        if (new Set(entries.map((entry) => entry.deviceId)).size !== entries.length) return null;
        return { kind: "standings", raceId: value.raceId, senderDeviceId: value.senderDeviceId, entries };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
