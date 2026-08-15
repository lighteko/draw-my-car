/**
 * tracks.ts — track geometry, shared by the server-side map store and the scene.
 *
 * Tracks can be bundled official maps or admin-uploaded maps (see lib/maps.ts).
 * Tracks use a "gate racing" model: an ordered loop of gates on open ground that players
 * drive through in sequence, N laps. No walled circuit needed — this keeps geometry cheap
 * and lap detection robust (planar proximity to the next expected gate). Gate rotations and
 * the spawn grid are derived from the gate path so tracks are defined by positions alone.
 */

import type { VehicleTuning } from "@/lib/vehicleTuning";
import type { GraphicsSettings } from "@/lib/graphicsSettings";

export type Vec3 = [number, number, number];

export interface Gate {
  position: Vec3;
  /** Yaw so local +Z points along travel; posts straddle the track on local ±X. */
  rotationY: number;
  /** Half-width of the opening (also the lap-trigger radius). */
  width: number;
}

export interface SpawnPoint {
  position: Vec3;
  rotationY: number;
}

export type DecorationKind = "cone" | "crate" | "pillar";
export interface Decoration {
  position: Vec3;
  kind: DecorationKind;
}

export interface TrackMeta {
  id: string;
  name: string;
  blurb: string;
}

/** A pose exactly as the admin authored it: the car's position and heading when captured. */
export interface AuthoredPose {
  position: Vec3;
  rotationY: number;
}

export interface TrackDef extends TrackMeta {
  /** Bundled maps are always available and cannot be deleted from the map lab. */
  official?: boolean;
  groundColor: string;
  /** Gate + accent color. */
  accent: string;
  skyColor: string;
  /** Ordered loop; index 0 is the start/finish gate. */
  gates: Gate[];
  spawns: SpawnPoint[];
  /**
   * The admin-authored start pose the grid is built around. Absent means the grid is
   * derived from the gate loop instead (and free-drive maps start at the world origin).
   */
  spawnOrigin?: AuthoredPose | null;
  decorations: Decoration[];
  defaultLaps: number;
  /** Optional uploaded GLB environment rendered with fixed mesh collision. */
  modelUrl?: string | null;
  modelScale?: number;
  /** Vehicle settings saved from the admin test panel; merged over the defaults. */
  tuning?: Partial<VehicleTuning>;
  /** Scene lighting/environment saved from the admin graphics panel; merged over the defaults. */
  graphics?: Partial<GraphicsSettings>;
  createdAt?: number;
}

const GATE_WIDTH = 5;
const GRID_BACK = 7; // how far behind gate 0 the derived start sits

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function norm(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
function yawFromDir(dir: Vec3): number {
  // Angle so that (0,0,1) rotated by yaw about +Y aligns with dir on the XZ plane.
  return Math.atan2(dir[0], dir[2]);
}

/** Build gates from a loop of points, orienting each along its local tangent. */
function makeGates(points: Vec3[]): Gate[] {
  const n = points.length;
  return points.map((p, i) => {
    const next = points[(i + 1) % n];
    const prev = points[(i - 1 + n) % n];
    const tangent = norm(sub(next, prev));
    return { position: p, rotationY: yawFromDir(tangent), width: GATE_WIDTH };
  });
}

/**
 * The single start pose behind gate 0, facing gate 1.
 *
 * Everyone starts on the same spot — no staggered grid. Cars pass through each other
 * (remote vehicles are sensor colliders), so overlapping at the line is harmless, and one
 * shared start keeps every racer's distance to the first gate identical.
 */
function makeSpawns(points: Vec3[]): SpawnPoint[] {
  const into = norm(sub(points[1] ?? points[0], points[0])); // travel direction at start
  return [
    {
      position: [
        points[0][0] - into[0] * GRID_BACK,
        points[0][1],
        points[0][2] - into[2] * GRID_BACK,
      ],
      rotationY: yawFromDir(into),
    },
  ];
}

function buildTrack(
  meta: TrackMeta & {
    groundColor: string;
    accent: string;
    skyColor: string;
    defaultLaps?: number;
  },
  points: Vec3[],
  decorations: Decoration[] = [],
): TrackDef {
  return {
    ...meta,
    gates: makeGates(points),
    spawns: makeSpawns(points),
    decorations,
    defaultLaps: meta.defaultLaps ?? 3,
  };
}

/**
 * The start for an admin-authored pose: exactly where the admin parked, for everyone.
 * Returned as a list because that is the shape a track carries, but it is always one entry.
 */
export function makeSpawnPoints(origin: AuthoredPose): SpawnPoint[] {
  return [{ position: origin.position, rotationY: origin.rotationY }];
}

/**
 * Rebuild the ordered gate loop + spawn grid from admin-authored checkpoints.
 *
 * Gate positions AND headings are taken verbatim from what was authored — the heading is NOT
 * re-derived from the loop tangent (which mangles it when the driven path isn't a clean closed
 * loop). The grid comes from `spawnOrigin` when the admin authored one; otherwise it is derived
 * from the checkpoint positions, and an empty loop with no authored start collapses the map
 * back to free drive from the world origin.
 */
export function makeCheckpointGeometry(
  checkpoints: AuthoredPose[],
  spawnOrigin?: AuthoredPose | null,
): {
  gates: Gate[];
  spawns: SpawnPoint[];
} {
  const gates: Gate[] = checkpoints.map((cp) => ({
    position: cp.position,
    rotationY: cp.rotationY,
    width: GATE_WIDTH,
  }));
  if (spawnOrigin) return { gates, spawns: makeSpawnPoints(spawnOrigin) };
  if (checkpoints.length === 0) {
    return { gates: [], spawns: [{ position: [0, 0, 0], rotationY: 0 }] };
  }
  return { gates, spawns: makeSpawns(checkpoints.map((cp) => cp.position)) };
}

/** Length of one lap in metres: the gate loop measured end to end, closing back to gate 0. */
export function lapDistance(gates: Gate[]): number {
  if (gates.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < gates.length; i++) {
    const a = gates[i].position;
    const b = gates[(i + 1) % gates.length].position;
    total += Math.hypot(b[0] - a[0], b[2] - a[2]);
  }
  return total;
}

/**
 * Rough seconds a race will take, for the lobby. Deliberately pessimistic about pace: a lap
 * average well below top speed accounts for corners, mistakes, and the standing start.
 */
export function estimateRaceSeconds(gates: Gate[], laps: number): number {
  const metres = lapDistance(gates) * Math.max(1, laps);
  const metresPerSecond = 13; // ~47 km/h average
  return Math.round(metres / metresPerSecond);
}

/** Build a track from admin-authored checkpoint positions. */
export function createTrackDefinition(
  meta: TrackMeta & {
    groundColor: string;
    accent: string;
    skyColor: string;
    defaultLaps: number;
    modelUrl?: string | null;
    modelScale?: number;
    createdAt?: number;
  },
  points: Vec3[],
): TrackDef {
  if (points.length === 0) {
    return {
      ...meta,
      gates: [],
      spawns: [{ position: [0, 0, 0], rotationY: 0 }],
      decorations: [],
      modelUrl: meta.modelUrl ?? null,
      modelScale: meta.modelScale ?? 1,
      createdAt: meta.createdAt,
    };
  }
  return {
    ...buildTrack(meta, points),
    modelUrl: meta.modelUrl ?? null,
    modelScale: meta.modelScale ?? 1,
    createdAt: meta.createdAt,
  };
}
