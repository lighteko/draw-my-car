import { Box3, MathUtils, Mesh, Object3D, Vector3 } from "three";

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
 * Invoke `cb` for each mesh vertex of `object`, transformed into world space.
 * Callers must have updated the object's world matrices first. A single Vector3 is
 * reused between calls, so `cb` must read it immediately rather than retain it.
 */
function forEachWorldVertex(object: Object3D, cb: (v: Vector3) => void): void {
  const v = new Vector3();
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const pos = child.geometry.getAttribute("position");
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld);
      cb(v);
    }
  });
}

/**
 * Yaw (rotation about +Y) of the model's dominant horizontal axis, via PCA over the
 * vertices projected onto the ground (XZ) plane.
 *
 * Generated cars are reconstructed from a 3/4 "front-left corner" render with Tripo's
 * orientation=align_image, so their length axis inherits the camera's yaw and points
 * ~10-20° off +Z. A 90° bounding-box swap can't undo that; this recovers the angle so
 * the caller can cancel it. Returns the angle of the longest footprint axis measured
 * from +Z toward +X, or null for an empty mesh.
 */
function horizontalPrincipalYaw(object: Object3D): number | null {
  object.updateMatrixWorld(true);

  let n = 0;
  let cx = 0;
  let cz = 0;
  forEachWorldVertex(object, (v) => {
    cx += v.x;
    cz += v.z;
    n++;
  });
  if (n === 0) return null;
  cx /= n;
  cz /= n;

  // Covariance of the centered XZ footprint.
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  forEachWorldVertex(object, (v) => {
    const dx = v.x - cx;
    const dz = v.z - cz;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  });

  // Major eigenvector of the symmetric 2x2 covariance [[sxx, sxz], [sxz, szz]].
  if (Math.abs(sxz) < 1e-9) {
    // Already axis-aligned: length is on Z (yaw 0) or on X (yaw 90°).
    return sxx > szz ? Math.PI / 2 : 0;
  }
  const tr = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const major = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  return Math.atan2(major - szz, sxz);
}

/**
 * Whether the car points -Z (nose at the rear) once its length axis is already on Z.
 * Heuristic: a car's cabin/roof mass sits toward the back, so if the upper body leans
 * +Z then the nose is at -Z. Conservative — only reports backward past a small deadband
 * (~5% of body length) so near-symmetric toys aren't sent backwards by noise.
 */
function facesBackward(object: Object3D): boolean {
  const box = getBounds(object);
  if (box.isEmpty()) return false;
  const center = box.getCenter(new Vector3());
  const halfLength = (box.max.z - box.min.z) / 2;

  let zSum = 0;
  let count = 0;
  forEachWorldVertex(object, (v) => {
    if (v.y >= center.y) {
      zSum += v.z;
      count++;
    }
  });
  if (count === 0) return false;

  return zSum / count - center.z > halfLength * 0.1;
}

/**
 * Normalize a generated mesh in place so its long horizontal axis is +Z, it faces
 * forward (+Z), is centered at the chassis origin, and its size is in sane
 * vehicle-scale meters.
 */
export function normalizeOrientation(object: Object3D): void {
  let box = getBounds(object);
  if (box.isEmpty()) return;

  // 1. Cancel the inherited 3/4-camera yaw: rotate the dominant footprint axis onto Z.
  const yaw = horizontalPrincipalYaw(object);
  if (yaw != null) {
    object.rotateY(-yaw);
    object.updateMatrixWorld(true);
  }

  // 2. Guard square footprints: if the long extent still reads as X, swap X<->Z.
  box = getBounds(object);
  let size = box.getSize(new Vector3());
  if (size.x > size.z) {
    object.rotateY(Math.PI / 2);
    object.updateMatrixWorld(true);
  }

  // 3. Point the nose toward +Z (physics forward), flipping if the body reads backwards.
  if (facesBackward(object)) {
    object.rotateY(Math.PI);
    object.updateMatrixWorld(true);
  }

  // 4. Scale to vehicle length, then center on the chassis origin.
  box = getBounds(object);
  size = box.getSize(new Vector3());
  const length = Math.max(size.z, size.x);
  if (length > 0) {
    object.scale.multiplyScalar(TARGET_LENGTH_METERS / length);
  }

  box = getBounds(object);
  const center = box.getCenter(new Vector3());
  object.position.sub(center);
  object.updateMatrixWorld(true);

  if (process.env.NODE_ENV !== "production") {
    const residual = horizontalPrincipalYaw(object);
    if (residual != null) {
      const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(1);
      console.debug(`[rig] normalizeOrientation yaw ${deg(yaw ?? 0)}° -> ${deg(residual)}°`);
    }
  }
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
