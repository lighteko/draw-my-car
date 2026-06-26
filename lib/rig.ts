import { Box3, MathUtils, Object3D, Vector3 } from "three";

/**
 * rig.ts - seam between generated visual meshes and the physics rig.
 *
 * The generated GLB is only the visual. Physics remains a derived chassis collider
 * plus four raycast wheels in chassis-local coordinates.
 *
 * Conventions:
 *   forward = +Z, up = +Y, right = +X. Wheel positions are in chassis-local space.
 */

export type Vec3 = [number, number, number];

export interface WheelSpec {
  /** Suspension connection point in chassis-local space (where the spring attaches). */
  position: Vec3;
  /** Wheel radius (m). */
  radius: number;
  /** Wheel width (m) - visual only. */
  width: number;
  /** Turns with steering input (typically the front wheels). */
  isSteering: boolean;
  /** Receives engine + reverse force (drivetrain). */
  isDriven: boolean;
}

export interface RigSpec {
  /** Half-extents of the chassis cuboid collider: [halfWidth(x), halfHeight(y), halfLength(z)]. */
  chassisHalfExtents: Vec3;
  /** Chassis rigid-body mass (kg). Engine/brake constants are tuned against this. */
  chassisMass: number;
  wheels: WheelSpec[];
}

const PLACEHOLDER_RIG: RigSpec = {
  chassisHalfExtents: [0.9, 0.4, 1.9],
  chassisMass: 150,
  wheels: [
    { position: [0.85, -0.25, 1.25], radius: 0.38, width: 0.3, isSteering: true, isDriven: false },
    { position: [-0.85, -0.25, 1.25], radius: 0.38, width: 0.3, isSteering: true, isDriven: false },
    { position: [0.85, -0.25, -1.25], radius: 0.38, width: 0.3, isSteering: false, isDriven: true },
    { position: [-0.85, -0.25, -1.25], radius: 0.38, width: 0.3, isSteering: false, isDriven: true },
  ],
};

const TARGET_LENGTH_METERS = 3.8;

/** Returns a deep copy of the placeholder rig so callers can mutate freely. */
export function getPlaceholderRig(): RigSpec {
  return {
    chassisHalfExtents: [...PLACEHOLDER_RIG.chassisHalfExtents],
    chassisMass: PLACEHOLDER_RIG.chassisMass,
    wheels: PLACEHOLDER_RIG.wheels.map((w) => ({ ...w, position: [...w.position] as Vec3 })),
  };
}

function getBounds(object: Object3D): Box3 {
  object.updateMatrixWorld(true);
  return new Box3().setFromObject(object);
}

function clamp(value: number, min: number, max: number): number {
  return MathUtils.clamp(value, min, max);
}

/**
 * Normalize a generated mesh in place so its long horizontal axis is +Z, it is
 * centered at the chassis origin, and its size is in sane vehicle-scale meters.
 */
export function normalizeOrientation(object: Object3D): void {
  let box = getBounds(object);
  if (box.isEmpty()) return;

  let size = box.getSize(new Vector3());
  if (size.x > size.z) {
    object.rotateY(Math.PI / 2);
    box = getBounds(object);
    size = box.getSize(new Vector3());
  }

  const length = Math.max(size.z, size.x);
  if (length > 0) {
    object.scale.multiplyScalar(TARGET_LENGTH_METERS / length);
  }

  box = getBounds(object);
  const center = box.getCenter(new Vector3());
  object.position.sub(center);
  object.updateMatrixWorld(true);
}

/**
 * Attempt to classify wheel meshes from a segmented model into wheel specs.
 * Real part segmentation is v2; v1 deliberately falls back to bounding-box wheels.
 */
export function classifyWheels(_object: Object3D): WheelSpec[] | null {
  return null;
}

/**
 * Derive a physics rig from the normalized generated GLB scene.
 */
export function deriveRigFromObject(object: Object3D): RigSpec {
  const classified = classifyWheels(object);
  if (classified) {
    const box = getBounds(object);
    const size = box.getSize(new Vector3());
    return {
      chassisHalfExtents: [
        clamp(size.x * 0.42, 0.45, 1.4),
        clamp(size.y * 0.28, 0.25, 0.9),
        clamp(size.z * 0.42, 0.9, 2.6),
      ],
      chassisMass: 150,
      wheels: classified,
    };
  }

  const box = getBounds(object);
  if (box.isEmpty()) return getPlaceholderRig();

  const size = box.getSize(new Vector3());
  const hx = clamp(size.x * 0.42, 0.45, 1.4);
  const hy = clamp(size.y * 0.28, 0.25, 0.9);
  const hz = clamp(size.z * 0.42, 0.9, 2.6);
  const radius = clamp(Math.min(size.x, size.z) * 0.11, 0.22, 0.48);
  const width = clamp(size.x * 0.12, 0.18, 0.42);
  const trackX = clamp(hx * 0.95, radius * 1.5, hx + radius * 0.4);
  const axleZ = clamp(hz * 0.68, radius * 1.8, hz - radius * 0.3);
  const connectionY = -hy * 0.55;

  return {
    chassisHalfExtents: [hx, hy, hz],
    chassisMass: 150,
    wheels: [
      { position: [trackX, connectionY, axleZ], radius, width, isSteering: true, isDriven: false },
      { position: [-trackX, connectionY, axleZ], radius, width, isSteering: true, isDriven: false },
      { position: [trackX, connectionY, -axleZ], radius, width, isSteering: false, isDriven: true },
      { position: [-trackX, connectionY, -axleZ], radius, width, isSteering: false, isDriven: true },
    ],
  };
}
