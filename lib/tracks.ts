/**
 * tracks.ts — race track catalogue.
 *
 * Tracks use a "gate racing" model: an ordered loop of gates on open ground that players
 * drive through in sequence, N laps. No walled circuit needed — this keeps geometry cheap
 * and lap detection robust (planar proximity to the next expected gate). Gate rotations and
 * the spawn grid are derived from the gate path so tracks are defined by positions alone.
 */

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

export interface TrackDef extends TrackMeta {
  groundColor: string;
  /** Gate + accent color. */
  accent: string;
  skyColor: string;
  /** Ordered loop; index 0 is the start/finish gate. */
  gates: Gate[];
  spawns: SpawnPoint[];
  decorations: Decoration[];
  defaultLaps: number;
}

const GATE_WIDTH = 5;
const GRID_BACK = 7; // how far behind gate 0 the front row spawns
const GATE_RADIUS = GATE_WIDTH; // planar lap-trigger radius

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

/** A staggered grid of up to `count` spawns behind gate 0, facing gate 1. */
function makeSpawns(points: Vec3[], count = 8): SpawnPoint[] {
  const into = norm(sub(points[1] ?? points[0], points[0])); // travel direction at start
  const yaw = yawFromDir(into);
  const lateral: Vec3 = [into[2], 0, -into[0]]; // perpendicular on the ground
  const spawns: SpawnPoint[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const side = i % 2 === 0 ? -1 : 1;
    const lane = side * (3 + (i % 2 === 0 ? 0 : 0)); // ±3m lanes
    const back = GRID_BACK + row * 4;
    spawns.push({
      position: [
        points[0][0] - into[0] * back + lateral[0] * lane,
        0,
        points[0][2] - into[2] * back + lateral[2] * lane,
      ],
      rotationY: yaw,
    });
  }
  return spawns;
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

// Wide, flowing oval-ish circuit.
const SUNSET = buildTrack(
  {
    id: "sunset-circuit",
    name: "Sunset Circuit",
    blurb: "Flowing curves, gentle chicane",
    groundColor: "#6b5a4a",
    accent: "#f97316",
    skyColor: "#fbbf24",
  },
  [
    [0, 0, 40],
    [26, 0, 30],
    [34, 0, 6],
    [22, 0, -18],
    [0, 0, -30],
    [-22, 0, -18],
    [-34, 0, 6],
    [-26, 0, 30],
  ],
);

// Big, near-circular oval — room for drifting.
const DUST = buildTrack(
  {
    id: "dust-bowl",
    name: "Dust Bowl",
    blurb: "Wide oval, big drifts",
    groundColor: "#8a7a5c",
    accent: "#eab308",
    skyColor: "#fde68a",
    defaultLaps: 3,
  },
  [
    [0, 0, 44],
    [30, 0, 34],
    [42, 0, 0],
    [30, 0, -34],
    [0, 0, -44],
    [-30, 0, -34],
    [-42, 0, 0],
    [-30, 0, 34],
  ],
  [
    { position: [0, 0, 0], kind: "pillar" },
    { position: [12, 0, 12], kind: "cone" },
    { position: [-12, 0, -12], kind: "cone" },
  ],
);

// Tight technical zig-zag loop.
const HARBOR = buildTrack(
  {
    id: "harbor-loop",
    name: "Harbor Loop",
    blurb: "Tight technical dockside",
    groundColor: "#4b5563",
    accent: "#38bdf8",
    skyColor: "#93c5fd",
  },
  [
    [0, 0, 30],
    [18, 0, 24],
    [14, 0, 6],
    [28, 0, -8],
    [16, 0, -24],
    [-6, 0, -20],
    [-4, 0, -2],
    [-20, 0, 10],
    [-16, 0, 26],
  ],
  [
    { position: [8, 0, 0], kind: "crate" },
    { position: [-10, 0, 4], kind: "crate" },
  ],
);

export const TRACKS: TrackDef[] = [SUNSET, DUST, HARBOR];

export const GATE_TRIGGER_RADIUS = GATE_RADIUS;

export function getTrack(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}

export function trackName(id: string): string {
  return TRACKS.find((t) => t.id === id)?.name ?? id;
}

export function randomTrackId(): string {
  return TRACKS[Math.floor(Math.random() * TRACKS.length)].id;
}

/** Resolve a settings trackId ("random" or a specific id) to a concrete track id. */
export function resolveTrackId(trackId: string): string {
  return trackId === "random" ? randomTrackId() : trackId;
}
