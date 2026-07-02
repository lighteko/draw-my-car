"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Sky, useGLTF } from "@react-three/drei";
import { Physics, RigidBody, CuboidCollider, type RapierRigidBody } from "@react-three/rapier";
import { deriveRigFromObject, getPlaceholderRig, normalizeOrientation, type RigSpec } from "@/lib/rig";
import { VehicleRig } from "./VehicleRig";
import { Hud } from "./Hud";

/**
 * Simulator — the client-only R3F + Rapier driving scene.
 *
 * MUST be rendered client-side only (it needs WebGL + window). It's loaded via a
 * dynamic({ ssr:false }) wrapper (SimulatorClient) so Next never tries to SSR it.
 *
 * v0 uses a procedural environment (no external GLBs) and the placeholder rig. In v1
 * `carId` resolves to a generated GLB whose derived rig is passed to <VehicleRig>.
 */
export default function Simulator({ carId }: { carId: string }) {
  // Stable rig instance so the vehicle controller isn't recreated each render.
  const rig = useMemo(() => getPlaceholderRig(), []);
  const chassisRef = useRef<RapierRigidBody>(null);

  return (
    <div className="relative h-full w-full">
      <Canvas shadows camera={{ position: [0, 6, -12], fov: 60 }}>
        <Suspense fallback={null}>
          <Scene carId={carId} placeholderRig={rig} chassisRef={chassisRef} />
        </Suspense>
      </Canvas>

      {/* DOM overlays (outside the Canvas) */}
      <Hud bodyRef={chassisRef} />
      <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/45 px-4 py-1.5 font-mono text-xs text-white backdrop-blur">
        car: {carId}
      </div>
    </div>
  );
}

function Scene({
  carId,
  placeholderRig,
  chassisRef,
}: {
  carId: string;
  placeholderRig: RigSpec;
  chassisRef: RefObject<RapierRigidBody | null>;
}) {
  return (
    <>
      <Sky sunPosition={[100, 40, 100]} />
      <ambientLight intensity={0.6} />
      <hemisphereLight intensity={0.35} groundColor="#3a3a3a" />
      <directionalLight
        castShadow
        position={[40, 60, 20]}
        intensity={2}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={1}
        shadow-camera-far={200}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
      />

      <Physics>
        <Environment />
        {carId === "placeholder" ? (
          <VehicleRig
            rig={placeholderRig}
            bodyRef={chassisRef as RefObject<RapierRigidBody | null>}
          />
        ) : (
          <GeneratedVehicle carId={carId} bodyRef={chassisRef as RefObject<RapierRigidBody | null>} />
        )}
      </Physics>

      <ChaseCamera target={chassisRef} />
    </>
  );
}

interface CarResponse {
  car: { glbUrl: string | null } | null;
}

function GeneratedVehicle({
  carId,
  bodyRef,
}: {
  carId: string;
  bodyRef: RefObject<RapierRigidBody | null>;
}) {
  const [carUrl, setCarUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function resolveCar() {
      try {
        const res = await fetch(`/api/cars/${encodeURIComponent(carId)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`failed to resolve car (${res.status})`);
        const data = (await res.json()) as CarResponse;
        if (!data.car?.glbUrl) throw new Error("car has no model");
        setCarUrl(data.car.glbUrl);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "failed to load car");
        }
      }
    }

    resolveCar();
    return () => controller.abort();
  }, [carId]);

  if (error) return null;
  if (!carUrl) return null;

  return <LoadedVehicle carUrl={carUrl} bodyRef={bodyRef} />;
}

function LoadedVehicle({
  carUrl,
  bodyRef,
}: {
  carUrl: string;
  bodyRef: RefObject<RapierRigidBody | null>;
}) {
  const gltf = useGLTF(carUrl);
  const visual = useMemo(() => {
    const object = gltf.scene.clone(true);
    normalizeOrientation(object);
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return object;
  }, [gltf.scene]);
  const rig = useMemo(() => deriveRigFromObject(visual), [visual]);

  return <VehicleRig rig={rig} bodyRef={bodyRef} visual={<primitive object={visual} />} />;
}

/**
 * Procedural environment: ground, ramps, knock-around obstacles, and boundary walls.
 * Physics colliders are fixed (except the dynamic obstacle crates). The wheels raycast
 * down onto the ground collider whose top surface sits at y = 0.
 */
function Environment() {
  // Deterministic scatter of dynamic crates (no Math.random needed).
  const crates = useMemo<[number, number][]>(
    () => [
      [6, 8],
      [-7, 12],
      [9, -6],
      [-10, -9],
      [3, 18],
      [-4, -16],
      [14, 4],
      [-14, -2],
    ],
    [],
  );

  return (
    <group>
      {/* Ground collider (top at y = 0) + visuals */}
      <RigidBody type="fixed" friction={1.1} colliders={false}>
        <CuboidCollider args={[100, 0.1, 100]} position={[0, -0.1, 0]} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color="#5b6b54" roughness={1} />
        </mesh>
      </RigidBody>
      <Grid
        position={[0, 0.01, 0]}
        args={[200, 200]}
        cellSize={2}
        cellThickness={0.6}
        cellColor="#3f4a3a"
        sectionSize={10}
        sectionThickness={1.2}
        sectionColor="#2b3327"
        fadeDistance={120}
        fadeStrength={1}
        infiniteGrid
      />

      {/* Ramps */}
      <Ramp position={[0, 0, 22]} rotation={[-0.22, 0, 0]} size={[8, 0.4, 10]} />
      <Ramp position={[20, 0, -8]} rotation={[-0.18, Math.PI / 2, 0]} size={[6, 0.4, 9]} />
      <Ramp position={[-18, 0, 6]} rotation={[-0.28, -0.4, 0]} size={[6, 0.4, 8]} />

      {/* Fixed pillars to slalom around */}
      {[
        [0, -10],
        [4, -10],
        [-4, -10],
        [8, -22],
        [-8, -22],
      ].map(([x, z], i) => (
        <RigidBody key={`p${i}`} type="fixed" colliders="cuboid" position={[x, 1.25, z]}>
          <mesh castShadow receiveShadow>
            <boxGeometry args={[0.8, 2.5, 0.8]} />
            <meshStandardMaterial color="#b45309" roughness={0.7} />
          </mesh>
        </RigidBody>
      ))}

      {/* Dynamic crates the car can knock around */}
      {crates.map(([x, z], i) => (
        <RigidBody
          key={`c${i}`}
          type="dynamic"
          colliders="cuboid"
          mass={4}
          position={[x, 0.6, z]}
        >
          <mesh castShadow receiveShadow>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="#a16207" roughness={0.85} />
          </mesh>
        </RigidBody>
      ))}

      {/* Boundary walls (keep the car inside a ~90×90 arena) */}
      <Wall position={[0, 1.5, 45]} size={[92, 3, 1]} />
      <Wall position={[0, 1.5, -45]} size={[92, 3, 1]} />
      <Wall position={[45, 1.5, 0]} size={[1, 3, 92]} />
      <Wall position={[-45, 1.5, 0]} size={[1, 3, 92]} />
    </group>
  );
}

function Ramp({
  position,
  rotation,
  size,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
  size: [number, number, number];
}) {
  return (
    <RigidBody type="fixed" colliders="cuboid" position={position} rotation={rotation}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={size} />
        <meshStandardMaterial color="#6b7280" roughness={0.9} />
      </mesh>
    </RigidBody>
  );
}

function Wall({
  position,
  size,
}: {
  position: [number, number, number];
  size: [number, number, number];
}) {
  return (
    <RigidBody type="fixed" colliders="cuboid" position={position}>
      <mesh receiveShadow>
        <boxGeometry args={size} />
        <meshStandardMaterial color="#374151" transparent opacity={0.5} />
      </mesh>
    </RigidBody>
  );
}

/**
 * ChaseCamera — follows the chassis from behind (-forward) and above, smoothed.
 * Reads the body transform directly; manipulates the default R3F camera.
 */
function ChaseCamera({ target }: { target: RefObject<RapierRigidBody | null> }) {
  const { camera } = useThree();
  const carPos = useMemo(() => new THREE.Vector3(), []);
  const carQuat = useMemo(() => new THREE.Quaternion(), []);
  const forward = useMemo(() => new THREE.Vector3(), []);
  const desired = useMemo(() => new THREE.Vector3(), []);
  const lookAt = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame((_, dt) => {
    const body = target.current;
    if (!body) return;
    const t = body.translation();
    const r = body.rotation();
    carPos.set(t.x, t.y, t.z);
    carQuat.set(r.x, r.y, r.z, r.w);
    forward.set(0, 0, 1).applyQuaternion(carQuat); // car forward = +Z

    // Behind the car (-forward) and above (+up). Method-call mutation only.
    desired.copy(carPos).addScaledVector(forward, -8).addScaledVector(up, 4);

    const lambda = 4;
    camera.position.set(
      THREE.MathUtils.damp(camera.position.x, desired.x, lambda, dt),
      THREE.MathUtils.damp(camera.position.y, desired.y, lambda, dt),
      THREE.MathUtils.damp(camera.position.z, desired.z, lambda, dt),
    );

    lookAt.copy(carPos).addScaledVector(up, 0.8);
    camera.lookAt(lookAt);
  });

  return null;
}
