"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import {
  CuboidCollider,
  RigidBody,
  useBeforePhysicsStep,
  useRapier,
  type RapierCollider,
  type RapierRigidBody,
} from "@react-three/rapier";
import type { DynamicRayCastVehicleController } from "@dimforge/rapier3d-compat";
import type { RigSpec } from "@/lib/rig";
import { DEFAULT_VEHICLE_TUNING, type VehicleTuning } from "@/lib/vehicleTuning";
import { useDriveControls } from "./useDriveControls";
import { getToonGradientMap } from "@/lib/doodle";

/**
 * VehicleRig builds a Rapier raycast vehicle from a RigSpec. Physics is always
 * the chassis cuboid plus raycast wheels; visuals can be either the placeholder
 * meshes or a generated GLB passed through `visual`.
 */

const STEER_DAMP = 8;
// Snappier back toward centre (or across it) than toward lock, so quick
// left-right transitions don't feel a beat behind the keys.
const STEER_RETURN_DAMP = 16;
// Steering lock fades from maxSteer to highSpeedSteer across this speed band
// (m/s). Full lock at parking speeds would demand several g of lateral grip at
// pace — the tires saturate and the car just plows (or rolls).
const STEER_FADE_START = 6;
const STEER_FADE_END = 24;

// Horizontal drag: rolling resistance (N per m/s, scaled by mass so coasting
// feels the same across the mass slider) plus a quadratic term derived from
// engine force and topSpeed, so full throttle converges on topSpeed and lifting
// off bleeds speed naturally instead of coasting forever.
const ROLLING_RESISTANCE_PER_KG = 0.09;

// Handbrake (Space): bias braking to the rear and let the rear tires slide.
const HANDBRAKE_REAR = 1.5;
const HANDBRAKE_FRONT = 0.4;

// Reverse gear tops out well below the drag-limited terminal speed (m/s).
const REVERSE_TOP_SPEED = 10;

// Auto-recovery: respawn after sliding on the roof this long, or after falling
// this far below the spawn height (custom GLB maps have no kill floor).
const UPSIDE_DOWN_RESET_S = 2;
const FALL_RESET_DEPTH = 20;

// Ground snap: on maps whose surface isn't at y≈0 (uploaded GLB environments),
// raycast down at the spawn and reseat the car on the first hit.
const SNAP_CAST_HEIGHT = 120;
const SNAP_CLEARANCE = 1.1;
const SNAP_TIMEOUT_S = 10;

const SUSPENSION_REST = 0.3;
const SUSPENSION_STIFFNESS = 28;
const SUSPENSION_COMPRESSION = 0.82;
const SUSPENSION_RELAXATION = 0.88;
const MAX_SUSPENSION_TRAVEL = 0.25;

// Share of the chassis mass packed into a thin plate at the floor of the hull.
// Rapier combines collider mass properties, so this pulls the centre of mass
// below the cuboid's centroid and resists rollovers under hard cornering.
const BALLAST_RATIO = 0.6;

const DOWN = { x: 0, y: -1, z: 0 };
const AXLE = { x: -1, y: 0, z: 0 };

export interface RespawnPoint {
  position: [number, number, number];
  rotationY: number;
}

export function VehicleRig({
  rig,
  bodyRef,
  visual,
  position = [0, 1.2, 0],
  rotationY = 0,
  enabled = true,
  anchorRef,
  tuning = DEFAULT_VEHICLE_TUNING,
  getRespawn,
}: {
  rig: RigSpec;
  bodyRef: RefObject<RapierRigidBody | null>;
  visual?: ReactNode;
  position?: [number, number, number];
  /** Spawn heading (yaw, radians). Also restored on reset. */
  rotationY?: number;
  /** When false, the car is held braked at the line (e.g. during the countdown). */
  enabled?: boolean;
  /** Optional anchor inside the interpolated rigid body — follow this for a jitter-free camera. */
  anchorRef?: RefObject<THREE.Object3D | null>;
  /** Live vehicle settings, exposed by the custom-map admin test panel. */
  tuning?: VehicleTuning;
  /** Where resets (manual R / auto-recovery) go — e.g. the last passed gate. Defaults to the spawn. */
  getRespawn?: () => RespawnPoint;
}) {
  const { world, rapier } = useRapier();
  const controllerRef = useRef<DynamicRayCastVehicleController | null>(null);
  const chassisColliderRef = useRef<RapierCollider>(null);
  const ballastColliderRef = useRef<RapierCollider>(null);
  const appliedMassRef = useRef<number | null>(null);
  const wheelRefs = useRef<(THREE.Group | null)[]>([]);
  const steerRef = useRef(0);
  const upsideDownForRef = useRef(0);
  const snapRef = useRef({ done: false, elapsed: 0 });
  const getInput = useDriveControls();

  const drivenWheelCount = useMemo(
    () => Math.max(1, rig.wheels.filter((w) => w.isDriven).length),
    [rig],
  );

  const alignQuat = useMemo(
    () => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
    [],
  );
  const steerQuat = useMemo(() => new THREE.Quaternion(), []);
  const rollQuat = useMemo(() => new THREE.Quaternion(), []);
  const chassisQuat = useMemo(() => new THREE.Quaternion(), []);
  const chassisUp = useMemo(() => new THREE.Vector3(), []);
  const forwardAxis = useMemo(() => new THREE.Vector3(), []);
  const xAxis = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  const yAxis = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useEffect(() => {
    let cancelled = false;
    let controller: DynamicRayCastVehicleController | null = null;

    const frame = requestAnimationFrame(() => {
      const chassis = bodyRef.current;
      if (cancelled || !chassis) return;

      const vehicle = world.createVehicleController(chassis);
      controller = vehicle;
      rig.wheels.forEach((w) => {
        vehicle.addWheel(
          { x: w.position[0], y: w.position[1], z: w.position[2] },
          DOWN,
          AXLE,
          SUSPENSION_REST,
          w.radius,
        );
      });
      for (let i = 0; i < rig.wheels.length; i++) {
        vehicle.setWheelSuspensionStiffness(i, SUSPENSION_STIFFNESS);
        vehicle.setWheelSuspensionCompression(i, SUSPENSION_COMPRESSION);
        vehicle.setWheelSuspensionRelaxation(i, SUSPENSION_RELAXATION);
        vehicle.setWheelMaxSuspensionTravel(i, MAX_SUSPENSION_TRAVEL);
        vehicle.setWheelFrictionSlip(i, DEFAULT_VEHICLE_TUNING.frictionSlip);
        vehicle.setWheelSideFrictionStiffness(i, DEFAULT_VEHICLE_TUNING.sideFriction);
      }
      controllerRef.current = vehicle;
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (controller) {
        if (controllerRef.current === controller) controllerRef.current = null;
        world.removeVehicleController(controller);
      }
    };
  }, [world, rig, bodyRef]);

  useBeforePhysicsStep(() => {
    const controller = controllerRef.current;
    const chassis = bodyRef.current;
    if (!controller || !chassis) return;

    const input = getInput();
    const dt = world.timestep;

    if (appliedMassRef.current !== tuning.carMass) {
      chassisColliderRef.current?.setMass(tuning.carMass * (1 - BALLAST_RATIO));
      ballastColliderRef.current?.setMass(tuning.carMass * BALLAST_RATIO);
      appliedMassRef.current = tuning.carMass;
      chassis.wakeUp();
    }

    const respawn = () => {
      const target = getRespawn?.() ?? { position, rotationY };
      const half = target.rotationY / 2;
      chassis.setTranslation(
        { x: target.position[0], y: target.position[1], z: target.position[2] },
        true,
      );
      chassis.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
      chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
      upsideDownForRef.current = 0;
    };

    // Seat the car on whatever surface is actually under the spawn. Uploaded GLB
    // maps may not have loaded their trimesh yet, so keep casting until the first
    // hit (the fall auto-reset below rescues the car in the meantime).
    if (!snapRef.current.done) {
      snapRef.current.elapsed += dt;
      const ray = new rapier.Ray(
        { x: position[0], y: position[1] + SNAP_CAST_HEIGHT, z: position[2] },
        DOWN,
      );
      const hit = world.castRay(
        ray,
        SNAP_CAST_HEIGHT * 3,
        true,
        rapier.QueryFilterFlags.EXCLUDE_SENSORS, // never seat the car on another player
        undefined,
        undefined,
        chassis,
      );
      if (hit) {
        const targetY = position[1] + SNAP_CAST_HEIGHT - hit.timeOfImpact + SNAP_CLEARANCE;
        if (Math.abs(chassis.translation().y - targetY) > 1.5) {
          const half = rotationY / 2;
          chassis.setTranslation({ x: position[0], y: targetY, z: position[2] }, true);
          chassis.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
          chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
          chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
        snapRef.current.done = true;
      } else if (snapRef.current.elapsed > SNAP_TIMEOUT_S) {
        snapRef.current.done = true;
      }
    }

    // Auto-recovery: roof-sliding or fallen off the world.
    const rot = chassis.rotation();
    chassisQuat.set(rot.x, rot.y, rot.z, rot.w);
    chassisUp.set(0, 1, 0).applyQuaternion(chassisQuat);
    upsideDownForRef.current = chassisUp.y < 0.05 ? upsideDownForRef.current + dt : 0;
    const fellOff = chassis.translation().y < position[1] - FALL_RESET_DEPTH;

    if (input.reset || upsideDownForRef.current > UPSIDE_DOWN_RESET_S || fellOff) {
      respawn();
    }

    const vel = chassis.linvel();
    const planarSpeed = Math.hypot(vel.x, vel.z);

    let engine = 0;
    let frontBrake = 0;
    let rearBrake = 0;
    let steerTarget = 0;
    const drifting = enabled && input.brake;
    if (enabled) {
      // Analog throttle: forward scales engine force, reverse scales reverse force.
      // Reverse cuts out at REVERSE_TOP_SPEED so backing up never reaches race pace.
      forwardAxis.set(0, 0, 1).applyQuaternion(chassisQuat);
      const forwardSpeed = vel.x * forwardAxis.x + vel.z * forwardAxis.z;
      engine =
        input.throttle >= 0
          ? input.throttle * tuning.engineForce
          : forwardSpeed > -REVERSE_TOP_SPEED
            ? input.throttle * tuning.reverseForce
            : 0;
      if (input.brake) {
        // Handbrake: rear-biased so the back steps out instead of the nose washing.
        frontBrake = tuning.brakeForce * HANDBRAKE_FRONT;
        rearBrake = tuning.brakeForce * HANDBRAKE_REAR;
      }
      // Available lock shrinks with speed — keeps binary keyboard steering precise
      // at pace and stops full-lock flick-rolls.
      const fade = THREE.MathUtils.clamp(
        (planarSpeed - STEER_FADE_START) / (STEER_FADE_END - STEER_FADE_START),
        0,
        1,
      );
      const lock = THREE.MathUtils.lerp(
        tuning.maxSteer,
        Math.min(tuning.highSpeedSteer, tuning.maxSteer),
        fade,
      );
      steerTarget = input.steer * lock;
    } else {
      // Held at the grid during the countdown.
      frontBrake = tuning.brakeForce;
      rearBrake = tuning.brakeForce;
    }
    const steerRate =
      Math.abs(steerTarget) < Math.abs(steerRef.current) ? STEER_RETURN_DAMP : STEER_DAMP;
    steerRef.current = THREE.MathUtils.damp(steerRef.current, steerTarget, steerRate, dt);

    // Drag: rolling + quadratic term sized so sustained full throttle tops out at
    // tuning.topSpeed. Applied against the horizontal velocity only.
    if (planarSpeed > 0.05) {
      const vmax = Math.max(5, tuning.topSpeed);
      const rolling = ROLLING_RESISTANCE_PER_KG * tuning.carMass;
      const maxDrive = tuning.engineForce * drivenWheelCount;
      const quad = Math.max(0, maxDrive - rolling * vmax) / (vmax * vmax);
      const dragForce = (rolling + quad * planarSpeed) * planarSpeed;
      const scale = (-dragForce * dt) / planarSpeed;
      chassis.applyImpulse({ x: vel.x * scale, y: 0, z: vel.z * scale }, true);
    }

    rig.wheels.forEach((w, i) => {
      // Grip settings are refreshed per step so the admin sliders take effect
      // without destroying and recreating the vehicle controller mid-drive.
      const rear = !w.isSteering;
      controller.setWheelFrictionSlip(i, tuning.frictionSlip);
      controller.setWheelSideFrictionStiffness(
        i,
        drifting && rear ? tuning.handbrakeSideFriction : tuning.sideFriction,
      );
      controller.setWheelEngineForce(i, w.isDriven ? engine : 0);
      controller.setWheelBrake(i, rear ? rearBrake : frontBrake);
      if (w.isSteering) controller.setWheelSteering(i, steerRef.current);
    });

    // EXCLUDE_SENSORS keeps the suspension rays off other players' cars. Remote cars are
    // sensor colliders so they never push you, but a wheel ray would still find one and the
    // car would climb a ghost that isn't really there.
    controller.updateVehicle(dt, rapier.QueryFilterFlags.EXCLUDE_SENSORS);
  });

  useFrame(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    for (let i = 0; i < rig.wheels.length; i++) {
      const group = wheelRefs.current[i];
      if (!group) continue;
      const connection = controller.wheelChassisConnectionPointCs(i);
      const suspension = controller.wheelSuspensionLength(i) ?? SUSPENSION_REST;
      const steering = controller.wheelSteering(i) ?? 0;
      const roll = controller.wheelRotation(i) ?? 0;
      if (connection) {
        group.position.set(connection.x, connection.y - suspension, connection.z);
      }
      steerQuat.setFromAxisAngle(yAxis, steering);
      rollQuat.setFromAxisAngle(xAxis, roll);
      group.quaternion.copy(steerQuat).multiply(rollQuat).multiply(alignQuat);
    }
  });

  const [hx, hy, hz] = rig.chassisHalfExtents;

  return (
    <RigidBody
      ref={bodyRef}
      position={position}
      rotation={[0, rotationY, 0]}
      colliders={false}
      canSleep={false}
      ccd
      type="dynamic"
    >
      <CuboidCollider
        ref={chassisColliderRef}
        args={[hx, hy, hz]}
        mass={rig.chassisMass * (1 - BALLAST_RATIO)}
      />
      <CuboidCollider
        ref={ballastColliderRef}
        args={[hx * 0.8, hy * 0.1, hz * 0.8]}
        position={[0, -hy * 0.85, 0]}
        mass={rig.chassisMass * BALLAST_RATIO}
      />
      {anchorRef ? <object3D ref={anchorRef} /> : null}

      {visual ?? (
        <>
          <DoodlePart color="#2563eb">
            <boxGeometry args={[hx * 2, hy * 2, hz * 2]} />
          </DoodlePart>

          <DoodlePart color="#1e3a8a" position={[0, hy + 0.18, -0.15]}>
            <boxGeometry args={[hx * 1.5, 0.4, hz * 0.95]} />
          </DoodlePart>

          <DoodlePart color="#fbbf24" position={[0, 0, hz * 0.96]} castShadow={false}>
            <boxGeometry args={[hx * 1.2, hy * 0.8, 0.12]} />
          </DoodlePart>

          {rig.wheels.map((w, i) => (
            <group
              key={i}
              ref={(el) => {
                wheelRefs.current[i] = el;
              }}
            >
              <DoodlePart color="#111827">
                <cylinderGeometry args={[w.radius, w.radius, w.width, 24]} />
              </DoodlePart>
              <DoodlePart color="#9ca3af" castShadow={false}>
                <boxGeometry args={[w.width + 0.02, w.radius * 1.7, 0.06]} />
              </DoodlePart>
            </group>
          ))}
        </>
      )}
    </RigidBody>
  );
}

/** A flat-shaded "doodle" part: a cel-banded toon mesh. */
function DoodlePart({
  color,
  position,
  castShadow = true,
  children,
}: {
  color: string;
  position?: [number, number, number];
  castShadow?: boolean;
  children: ReactNode;
}) {
  return (
    <group position={position}>
      <mesh castShadow={castShadow} receiveShadow>
        {children}
        <meshToonMaterial color={color} gradientMap={getToonGradientMap()} />
      </mesh>
    </group>
  );
}
