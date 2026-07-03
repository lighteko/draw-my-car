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
  type RapierRigidBody,
} from "@react-three/rapier";
import type { DynamicRayCastVehicleController } from "@dimforge/rapier3d-compat";
import type { RigSpec } from "@/lib/rig";
import { useDriveControls } from "./useDriveControls";
import { getToonGradientMap } from "@/lib/doodle";

/**
 * VehicleRig builds a Rapier raycast vehicle from a RigSpec. Physics is always
 * the chassis cuboid plus raycast wheels; visuals can be either the placeholder
 * meshes or a generated GLB passed through `visual`.
 */

const ENGINE_FORCE = 800;
const REVERSE_FORCE = 450;
const BRAKE_FORCE = 8;
const MAX_STEER = 0.55;
const STEER_DAMP = 8;

const SUSPENSION_REST = 0.3;
const SUSPENSION_STIFFNESS = 28;
const SUSPENSION_COMPRESSION = 0.82;
const SUSPENSION_RELAXATION = 0.88;
const MAX_SUSPENSION_TRAVEL = 0.25;
const FRICTION_SLIP = 5;
const SIDE_FRICTION = 1.0;

// Share of the chassis mass packed into a thin plate at the floor of the hull.
// Rapier combines collider mass properties, so this pulls the centre of mass
// below the cuboid's centroid and resists rollovers under hard cornering.
const BALLAST_RATIO = 0.6;

const DOWN = { x: 0, y: -1, z: 0 };
const AXLE = { x: -1, y: 0, z: 0 };

export function VehicleRig({
  rig,
  bodyRef,
  visual,
  position = [0, 1.2, 0],
  rotationY = 0,
  enabled = true,
  anchorRef,
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
}) {
  const { world } = useRapier();
  const controllerRef = useRef<DynamicRayCastVehicleController | null>(null);
  const wheelRefs = useRef<(THREE.Group | null)[]>([]);
  const steerRef = useRef(0);
  const getInput = useDriveControls();

  const alignQuat = useMemo(
    () => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
    [],
  );
  const steerQuat = useMemo(() => new THREE.Quaternion(), []);
  const rollQuat = useMemo(() => new THREE.Quaternion(), []);
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
        vehicle.setWheelFrictionSlip(i, FRICTION_SLIP);
        vehicle.setWheelSideFrictionStiffness(i, SIDE_FRICTION);
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

    if (input.reset) {
      const half = rotationY / 2;
      chassis.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
      chassis.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
      chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    let engine = 0;
    let brake = input.brake ? BRAKE_FORCE : 0;
    let steerTarget = 0;
    if (enabled) {
      // Analog throttle: forward scales engine force, reverse scales reverse force.
      engine = input.throttle >= 0 ? input.throttle * ENGINE_FORCE : input.throttle * REVERSE_FORCE;
      steerTarget = input.steer * MAX_STEER;
    } else {
      // Held at the grid during the countdown.
      brake = BRAKE_FORCE;
    }
    steerRef.current = THREE.MathUtils.damp(steerRef.current, steerTarget, STEER_DAMP, dt);

    rig.wheels.forEach((w, i) => {
      controller.setWheelEngineForce(i, w.isDriven ? engine : 0);
      controller.setWheelBrake(i, brake);
      if (w.isSteering) controller.setWheelSteering(i, steerRef.current);
    });

    controller.updateVehicle(dt);
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
      <CuboidCollider args={[hx, hy, hz]} mass={rig.chassisMass * (1 - BALLAST_RATIO)} />
      <CuboidCollider
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
