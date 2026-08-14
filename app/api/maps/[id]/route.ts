import { NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/adminAuth";
import { deleteMap, getMap, updateMapSettings } from "@/lib/maps";
import { DEFAULT_VEHICLE_TUNING, type VehicleTuning } from "@/lib/vehicleTuning";
import { DEFAULT_GRAPHICS_SETTINGS, type GraphicsSettings } from "@/lib/graphicsSettings";
import type { AuthoredPose, Vec3 } from "@/lib/tracks";

/** Guard rails for authored checkpoints. */
const MAX_CHECKPOINTS = 256;
const COORD_LIMIT = 5000;

/** Accepted range per tuning field, mirroring the admin panel's sliders. */
const TUNING_LIMITS: Record<keyof VehicleTuning, [number, number]> = {
  carMass: [300, 1500],
  engineForce: [1000, 14000],
  reverseForce: [500, 7000],
  brakeForce: [16, 192],
  maxSteer: [0.2, 0.8],
  highSpeedSteer: [0.05, 0.5],
  frictionSlip: [1, 14],
  sideFriction: [0.5, 3],
  handbrakeSideFriction: [0.1, 2],
  topSpeed: [10, 60],
};

/** Accepted range per numeric graphics field, mirroring the graphics panel's sliders. */
const GRAPHICS_LIMITS: Record<string, [number, number]> = {
  sunAzimuth: [0, 360],
  sunElevation: [1, 90],
  sunIntensity: [0, 5],
  ambient: [0, 2],
  fill: [0, 1.5],
  fogNear: [20, 400],
  fogFar: [100, 900],
  shadowMapSize: [256, 4096],
  shadowBias: [-0.001, 0.001],
  shadowNormalBias: [0, 0.1],
};
const GRAPHICS_BOOLEANS = ["shadows", "fog"] as const;

function sanitizeTuning(input: unknown): Partial<VehicleTuning> | null {
  if (typeof input !== "object" || input === null) return null;
  const source = input as Record<string, unknown>;
  const tuning: Partial<VehicleTuning> = {};
  for (const key of Object.keys(DEFAULT_VEHICLE_TUNING) as (keyof VehicleTuning)[]) {
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const [min, max] = TUNING_LIMITS[key];
    tuning[key] = Math.min(max, Math.max(min, value));
  }
  return Object.keys(tuning).length > 0 ? tuning : null;
}

function sanitizeGraphics(input: unknown): Partial<GraphicsSettings> | null {
  if (typeof input !== "object" || input === null) return null;
  const source = input as Record<string, unknown>;
  const graphics: Record<string, number | boolean> = {};
  for (const key of Object.keys(DEFAULT_GRAPHICS_SETTINGS) as (keyof GraphicsSettings)[]) {
    const value = source[key];
    if (GRAPHICS_BOOLEANS.includes(key as (typeof GRAPHICS_BOOLEANS)[number])) {
      if (typeof value === "boolean") graphics[key] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const [min, max] = GRAPHICS_LIMITS[key];
    graphics[key] = Math.min(max, Math.max(min, value));
  }
  return Object.keys(graphics).length > 0 ? (graphics as Partial<GraphicsSettings>) : null;
}

const clampCoord = (n: number) => Math.min(COORD_LIMIT, Math.max(-COORD_LIMIT, n));

/** Validate one authored pose (position + heading). Returns null when it is malformed. */
function sanitizePose(input: unknown): AuthoredPose | null {
  if (typeof input !== "object" || input === null) return null;
  const { position, rotationY } = input as { position?: unknown; rotationY?: unknown };
  if (!Array.isArray(position) || position.length !== 3) return null;
  const [x, y, z] = position as unknown[];
  if (![x, y, z].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (typeof rotationY !== "number" || !Number.isFinite(rotationY)) return null;
  return {
    position: [
      clampCoord(x as number),
      clampCoord(y as number),
      clampCoord(z as number),
    ] as Vec3,
    rotationY,
  };
}

/** Validate authored checkpoints. Returns null when the field is absent/malformed; an empty
 *  array is valid and clears the loop back to free drive. */
function sanitizeCheckpoints(input: unknown): AuthoredPose[] | null {
  if (!Array.isArray(input)) return null;
  const checkpoints: AuthoredPose[] = [];
  for (const entry of input.slice(0, MAX_CHECKPOINTS)) {
    const pose = sanitizePose(entry);
    if (!pose) return null;
    checkpoints.push(pose);
  }
  return checkpoints;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const map = getMap(id);
  if (!map) return NextResponse.json({ error: "맵을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json({ map });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isAdminAuthorized())) {
    return NextResponse.json({ error: "관리자 로그인이 필요합니다" }, { status: 401 });
  }
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다" }, { status: 400 });
  }
  const source = body as {
    tuning?: unknown;
    graphics?: unknown;
    checkpoints?: unknown;
    spawn?: unknown;
  };
  const tuning = sanitizeTuning(source?.tuning);
  const graphics = sanitizeGraphics(source?.graphics);
  const checkpoints =
    source?.checkpoints !== undefined ? sanitizeCheckpoints(source?.checkpoints) : null;
  if (source?.checkpoints !== undefined && checkpoints === null) {
    return NextResponse.json({ error: "체크포인트 값이 올바르지 않습니다" }, { status: 400 });
  }
  // `spawn: null` is meaningful — it clears the authored start pose.
  const hasSpawn = source?.spawn !== undefined;
  const spawn = hasSpawn && source.spawn !== null ? sanitizePose(source.spawn) : null;
  if (hasSpawn && source.spawn !== null && !spawn) {
    return NextResponse.json({ error: "출발 지점 값이 올바르지 않습니다" }, { status: 400 });
  }
  if (!tuning && !graphics && checkpoints === null && !hasSpawn) {
    return NextResponse.json(
      { error: "저장할 세팅·그래픽·체크포인트·출발점 값이 없습니다" },
      { status: 400 },
    );
  }
  const map = updateMapSettings(id, {
    ...(tuning ? { tuning } : {}),
    ...(graphics ? { graphics } : {}),
    ...(checkpoints !== null ? { checkpoints } : {}),
    ...(hasSpawn ? { spawn } : {}),
  });
  if (!map) return NextResponse.json({ error: "맵을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json({ map });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isAdminAuthorized())) {
    return NextResponse.json({ error: "관리자 로그인이 필요합니다" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!deleteMap(id)) return NextResponse.json({ error: "맵을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
