import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createTrackDefinition,
  makeCheckpointGeometry,
  makeSpawnPoints,
  type AuthoredPose,
  type TrackDef,
  type Vec3,
} from "@/lib/tracks";
import type { VehicleTuning } from "@/lib/vehicleTuning";
import type { GraphicsSettings } from "@/lib/graphicsSettings";
import officialMapsData from "@/lib/official-maps.json";

const DATA_DIR = path.resolve(
  /* turbopackIgnore: true */ process.cwd(),
  process.env.LOCAL_DATA_DIR ?? ".data",
);
const MAPS_PATH = path.join(DATA_DIR, "maps.json");
const TMP_PATH = path.join(DATA_DIR, "maps.json.tmp");

const OFFICIAL_MAPS = officialMapsData as unknown as TrackDef[];
const OFFICIAL_MAP_IDS = new Set(OFFICIAL_MAPS.map((map) => map.id));

export interface NewMap {
  name: string;
  blurb: string;
  points: Vec3[];
  gateWidth: number;
  defaultLaps: number;
  groundColor: string;
  accent: string;
  skyColor: string;
  modelUrl: string;
  modelScale: number;
}

function normalizeMap(map: TrackDef): TrackDef {
  // Maps saved before the shared start still carry a staggered grid; keep only the first
  // slot so every racer lines up on the same spot. Rewritten on the next save.
  return map.spawns?.length > 1 ? { ...map, spawns: map.spawns.slice(0, 1) } : map;
}

/** Apply only fields the map lab is allowed to tune; official identity and assets stay fixed. */
function mergeOfficialMap(base: TrackDef, stored?: TrackDef): TrackDef {
  return normalizeMap({
    ...base,
    ...(stored?.tuning ? { tuning: stored.tuning } : {}),
    ...(stored?.graphics ? { graphics: stored.graphics } : {}),
    ...(stored?.gates ? { gates: stored.gates } : {}),
    ...(stored?.spawns ? { spawns: stored.spawns } : {}),
    ...(stored && "spawnOrigin" in stored ? { spawnOrigin: stored.spawnOrigin } : {}),
    official: true,
  });
}

function loadStoredMaps(): TrackDef[] {
  if (!existsSync(MAPS_PATH)) return [];
  const parsed = JSON.parse(readFileSync(MAPS_PATH, "utf8")) as unknown;
  if (!Array.isArray(parsed)) return [];
  return (parsed as TrackDef[]).map(normalizeMap);
}

function persistMaps(maps: TrackDef[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TMP_PATH, `${JSON.stringify(maps, null, 2)}\n`, "utf8");
  renameSync(TMP_PATH, MAPS_PATH);
}

export function listMaps(): TrackDef[] {
  const stored = loadStoredMaps();
  const storedById = new Map(stored.map((map) => [map.id, map]));
  const official = OFFICIAL_MAPS.map((base) =>
    mergeOfficialMap(base, storedById.get(base.id)),
  );
  const custom = stored.filter((map) => !OFFICIAL_MAP_IDS.has(map.id));
  return [...official, ...custom].sort((a, b) => {
    if (Boolean(a.official) !== Boolean(b.official)) return a.official ? -1 : 1;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
}

export function getMap(id: string): TrackDef | undefined {
  const stored = loadStoredMaps();
  const base = OFFICIAL_MAPS.find((map) => map.id === id);
  if (base) return mergeOfficialMap(base, stored.find((map) => map.id === id));
  return stored.find((map) => map.id === id);
}

export function isOfficialMap(id: string): boolean {
  return OFFICIAL_MAP_IDS.has(id);
}

export function createMap(input: NewMap): TrackDef {
  const id = `custom-${randomUUID()}`;
  const map = createTrackDefinition(
    {
      id,
      name: input.name,
      blurb: input.blurb,
      groundColor: input.groundColor,
      accent: input.accent,
      skyColor: input.skyColor,
      defaultLaps: input.defaultLaps,
      modelUrl: input.modelUrl,
      modelScale: input.modelScale,
      createdAt: Date.now(),
    },
    input.points,
  );
  map.gates = map.gates.map((gate) => ({ ...gate, width: input.gateWidth }));
  const maps = loadStoredMaps();
  maps.push(map);
  persistMaps(maps);
  return map;
}

/**
 * Patch the admin-tunable settings on a map: vehicle tuning, scene graphics, the authored
 * checkpoint loop (which rebuilds the gates), and/or the authored start pose (which rebuilds
 * the grid). `spawn: null` clears the authored start, dropping the grid back to the loop.
 *
 * The two geometry fields are independent: saving checkpoints keeps an authored grid, and
 * saving a start pose keeps the existing gates.
 */
export function updateMapSettings(
  id: string,
  patch: {
    tuning?: Partial<VehicleTuning>;
    graphics?: Partial<GraphicsSettings>;
    checkpoints?: AuthoredPose[];
    spawn?: AuthoredPose | null;
  },
): TrackDef | undefined {
  const maps = loadStoredMaps();
  let index = maps.findIndex((map) => map.id === id);
  const officialBase = OFFICIAL_MAPS.find((map) => map.id === id);
  if (officialBase) {
    const current = mergeOfficialMap(officialBase, index >= 0 ? maps[index] : undefined);
    if (index >= 0) maps[index] = current;
    else {
      maps.push(current);
      index = maps.length - 1;
    }
  }
  if (index === -1) return undefined;
  const current = maps[index];

  const spawnOrigin = patch.spawn !== undefined ? patch.spawn : current.spawnOrigin ?? null;
  let geometry: { gates: TrackDef["gates"]; spawns: TrackDef["spawns"] } | null = null;
  if (patch.checkpoints) {
    geometry = makeCheckpointGeometry(patch.checkpoints, spawnOrigin);
  } else if (patch.spawn !== undefined) {
    // Start pose only — keep the gates and rebuild just the grid, re-deriving it from the
    // existing loop when the authored start was cleared.
    geometry = {
      gates: current.gates,
      spawns: spawnOrigin
        ? makeSpawnPoints(spawnOrigin)
        : makeCheckpointGeometry(
            current.gates.map((gate) => ({ position: gate.position, rotationY: gate.rotationY })),
          ).spawns,
    };
  }

  maps[index] = {
    ...current,
    ...(patch.tuning ? { tuning: patch.tuning } : {}),
    ...(patch.graphics ? { graphics: patch.graphics } : {}),
    ...(patch.spawn !== undefined ? { spawnOrigin } : {}),
    ...(geometry ? { gates: geometry.gates, spawns: geometry.spawns } : {}),
  };
  persistMaps(maps);
  return maps[index];
}

export function deleteMap(id: string): boolean {
  if (isOfficialMap(id)) return false;
  const maps = loadStoredMaps();
  const next = maps.filter((map) => map.id !== id);
  if (next.length === maps.length) return false;
  persistMaps(next);
  return true;
}
