import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createTrackDefinition,
  makeCheckpointGeometry,
  type AuthoredCheckpoint,
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
  return Array.isArray(parsed) ? (parsed as TrackDef[]) : [];
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
 * Patch the admin-tunable settings on a map: vehicle tuning, scene graphics, and/or the
 * authored checkpoint loop (`points`, which rebuilds the gates + spawn grid).
 */
export function updateMapSettings(
  id: string,
  patch: {
    tuning?: Partial<VehicleTuning>;
    graphics?: Partial<GraphicsSettings>;
    checkpoints?: AuthoredCheckpoint[];
  },
): TrackDef | undefined {
  const maps = loadMaps();
  const index = maps.findIndex((map) => map.id === id);
  if (index === -1) return undefined;
  const current = maps[index];
  const geometry = patch.checkpoints ? makeCheckpointGeometry(patch.checkpoints) : null;
  maps[index] = {
    ...current,
    ...(patch.tuning ? { tuning: patch.tuning } : {}),
    ...(patch.graphics ? { graphics: patch.graphics } : {}),
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
