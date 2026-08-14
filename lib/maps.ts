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

const DATA_DIR = path.resolve(
  /* turbopackIgnore: true */ process.cwd(),
  process.env.LOCAL_DATA_DIR ?? ".data",
);
const MAPS_PATH = path.join(DATA_DIR, "maps.json");
const TMP_PATH = path.join(DATA_DIR, "maps.json.tmp");

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

function loadMaps(): TrackDef[] {
  if (!existsSync(MAPS_PATH)) return [];
  const parsed = JSON.parse(readFileSync(MAPS_PATH, "utf8")) as unknown;
  if (!Array.isArray(parsed)) return [];
  // Maps saved before the shared start still carry a staggered grid; keep only the first
  // slot so every racer lines up on the same spot. Rewritten on the next save.
  return (parsed as TrackDef[]).map((map) =>
    map.spawns?.length > 1 ? { ...map, spawns: map.spawns.slice(0, 1) } : map,
  );
}

function persistMaps(maps: TrackDef[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TMP_PATH, `${JSON.stringify(maps, null, 2)}\n`, "utf8");
  renameSync(TMP_PATH, MAPS_PATH);
}

export function listMaps(): TrackDef[] {
  return loadMaps().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function getMap(id: string): TrackDef | undefined {
  return loadMaps().find((map) => map.id === id);
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
  const maps = loadMaps();
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
  const maps = loadMaps();
  const index = maps.findIndex((map) => map.id === id);
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
  const maps = loadMaps();
  const next = maps.filter((map) => map.id !== id);
  if (next.length === maps.length) return false;
  persistMaps(next);
  return true;
}
