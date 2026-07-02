"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { Physics, RigidBody, CuboidCollider, type RapierRigidBody } from "@react-three/rapier";
import {
  deriveRigFromObject,
  getPlaceholderRig,
  normalizeOrientation,
} from "@/lib/rig";
import { applyDoodleStyle } from "@/lib/doodle";
import { getTrack, GATE_TRIGGER_RADIUS, type Gate, type TrackDef } from "@/lib/tracks";
import { useAutoFullscreen } from "@/lib/fullscreen";
import type { Quat, Standing, Vec3n } from "@/lib/roomTypes";
import { VehicleRig } from "./VehicleRig";
import { RaceHud, type RaceResult } from "./RaceHud";
import { RemoteVehicle, type Snapshot } from "./RemoteVehicle";
import { TouchControls } from "./TouchControls";
import { Minimap } from "./Minimap";

export interface RemoteRacer {
  deviceId: string;
  glbUrl: string | null;
  spawnIndex: number;
}

/**
 * RaceScene — a single-player race on a gate track. Client-only (WebGL).
 *
 * The local car is the raycast VehicleRig; laps are counted by driving through the
 * ordered gates (planar proximity). The state machine is countdown → racing → finished.
 * Multiplayer (remote ghosts + synced standings) is layered on in the next phase.
 */

type Phase = "countdown" | "racing" | "finished";

interface Progress {
  nextGate: number;
  lap: number;
  lapStart: number;
  lapTimes: number[];
}

export function RaceScene({
  trackId,
  carGlbUrl,
  laps,
  spawnIndex = 0,
  onExit,
  remotes = [],
  remoteBuffers,
  onTransform,
  onProgress,
  onFinished,
  standings = [],
  selfDeviceId,
  spectator = false,
  exitLabel,
}: {
  trackId: string;
  carGlbUrl: string | null;
  laps: number;
  spawnIndex?: number;
  onExit?: () => void;
  /** Other racers to render as interpolated ghosts. */
  remotes?: RemoteRacer[];
  /** Per-device pose buffers, filled by the page from "transform" messages. */
  remoteBuffers?: RefObject<Map<string, Snapshot[]>>;
  /** Broadcast the local car pose (~20 Hz). */
  onTransform?: (p: Vec3n, q: Quat) => void;
  /** Report own lap progress to the owner for ranking. */
  onProgress?: (lap: number, nextGate: number) => void;
  onFinished?: (totalMs: number) => void;
  /** Owner-authoritative leaderboard for the HUD. */
  standings?: Standing[];
  /** Highlights the local player in the leaderboard. */
  selfDeviceId?: string;
  /** Spectators watch from an overview camera and don't drive. */
  spectator?: boolean;
  /** Label for the exit / results button (e.g. "Back to lobby"). */
  exitLabel?: string;
}) {
  useAutoFullscreen();
  const track = useMemo(() => getTrack(trackId), [trackId]);
  const spawn = track.spawns[spawnIndex % track.spawns.length];
  const chassisRef = useRef<RapierRigidBody>(null);
  const carAnchor = useRef<THREE.Object3D>(null);

  const [phase, setPhase] = useState<Phase>("countdown");
  const [countdown, setCountdown] = useState(3);
  const [lap, setLap] = useState(0);
  const [nextGate, setNextGate] = useState(1);
  const [lapTimes, setLapTimes] = useState<number[]>([]);
  const [result, setResult] = useState<RaceResult | null>(null);
  const [startAt, setStartAt] = useState<number | null>(null);

  const progress = useRef<Progress>({ nextGate: 1, lap: 0, lapStart: 0, lapTimes: [] });
  const emptyBuffers = useRef<Map<string, Snapshot[]>>(new Map());

  // Countdown 3 → 2 → 1 → GO. All transitions run inside timer callbacks (not
  // synchronously in the effect), and the effect runs once.
  useEffect(() => {
    const timers = [
      window.setTimeout(() => setCountdown(2), 1000),
      window.setTimeout(() => setCountdown(1), 2000),
      window.setTimeout(() => {
        const now = performance.now();
        progress.current.lapStart = now;
        setStartAt(now);
        setCountdown(0);
        setPhase("racing");
      }, 3000),
    ];
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  const onGatePass = () => {
    const p = progress.current;
    const total = track.gates.length;
    if (p.nextGate === 0) {
      const now = performance.now();
      p.lap += 1;
      p.lapTimes.push(now - p.lapStart);
      p.lapStart = now;
      p.nextGate = 1 % total;
      setLap(p.lap);
      setLapTimes([...p.lapTimes]);
      setNextGate(p.nextGate);
      onProgress?.(p.lap, p.nextGate);
      if (p.lap >= laps) {
        const totalMs = p.lapTimes.reduce((a, b) => a + b, 0);
        setResult({ totalMs, lapTimes: [...p.lapTimes] });
        setPhase("finished");
        onFinished?.(totalMs);
      }
    } else {
      p.nextGate = (p.nextGate + 1) % total;
      setNextGate(p.nextGate);
      onProgress?.(p.lap, p.nextGate);
    }
  };

  return (
    <div className="relative h-dvh w-full touch-none overflow-hidden bg-neutral-900">
      <Canvas shadows dpr={[1, 2]} camera={{ position: [0, 6, -12], fov: 60 }}>
        <color attach="background" args={[track.skyColor]} />
        <fog attach="fog" args={[track.skyColor, 80, 260]} />
        <ambientLight intensity={0.7} />
        <hemisphereLight intensity={0.4} groundColor="#2a2a2a" />
        <directionalLight
          castShadow
          position={[40, 70, 20]}
          intensity={2}
          shadow-mapSize={[1024, 1024]}
          shadow-camera-near={1}
          shadow-camera-far={260}
          shadow-camera-left={-90}
          shadow-camera-right={90}
          shadow-camera-top={90}
          shadow-camera-bottom={-90}
        />

        <Physics>
          <TrackView track={track} nextGate={nextGate} />

          {!spectator && (
            <>
              <Suspense fallback={null}>
                <RaceCar
                  glbUrl={carGlbUrl}
                  spawn={spawn}
                  enabled={phase === "racing"}
                  bodyRef={chassisRef}
                  anchorRef={carAnchor}
                />
              </Suspense>
              <LapTracker
                bodyRef={chassisRef}
                gates={track.gates}
                active={phase === "racing"}
                progress={progress}
                onGatePass={onGatePass}
              />
              {onTransform && <TransformBroadcaster bodyRef={chassisRef} onTransform={onTransform} />}
            </>
          )}

          {remotes.map((r) => (
            <RemoteVehicle
              key={r.deviceId}
              glbUrl={r.glbUrl}
              spawn={track.spawns[r.spawnIndex % track.spawns.length]}
              getBuffer={() => remoteBuffers?.current?.get(r.deviceId)}
            />
          ))}
        </Physics>

        {spectator ? <SpectatorCamera track={track} /> : <ChaseCamera target={carAnchor} />}
      </Canvas>

      <RaceHud
        phase={phase}
        countdown={countdown}
        lap={lap}
        totalLaps={laps}
        startAt={startAt}
        running={phase === "racing"}
        lapTimes={lapTimes}
        result={result}
        standings={standings}
        selfDeviceId={selfDeviceId}
        spectator={spectator}
        exitLabel={exitLabel}
        onExit={onExit}
      />
      {!spectator && <TouchControls />}
      <Minimap track={track} selfBody={chassisRef} remoteBuffers={remoteBuffers ?? emptyBuffers} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Track + gates
// ---------------------------------------------------------------------------

function TrackView({ track, nextGate }: { track: TrackDef; nextGate: number }) {
  return (
    <group>
      <RigidBody type="fixed" friction={1.1} colliders={false}>
        <CuboidCollider args={[200, 0.1, 200]} position={[0, -0.1, 0]} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[400, 400]} />
          <meshStandardMaterial color={track.groundColor} roughness={1} />
        </mesh>
      </RigidBody>

      {track.gates.map((gate, i) => (
        <GateView
          key={i}
          gate={gate}
          isStart={i === 0}
          isNext={i === nextGate}
          accent={track.accent}
        />
      ))}

      {track.decorations.map((d, i) => (
        <Decoration key={i} position={d.position} kind={d.kind} />
      ))}
    </group>
  );
}

function GateView({
  gate,
  isStart,
  isNext,
  accent,
}: {
  gate: Gate;
  isStart: boolean;
  isNext: boolean;
  accent: string;
}) {
  const color = isStart ? "#f8fafc" : accent;
  const emissive = isNext ? accent : "#000000";
  const emissiveIntensity = isNext ? 0.9 : 0;
  const span = gate.width * 2 + 0.4;
  return (
    <group position={gate.position} rotation={[0, gate.rotationY, 0]}>
      <mesh position={[gate.width, 1.6, 0]} castShadow>
        <boxGeometry args={[0.4, 3.2, 0.4]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={emissiveIntensity} />
      </mesh>
      <mesh position={[-gate.width, 1.6, 0]} castShadow>
        <boxGeometry args={[0.4, 3.2, 0.4]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={emissiveIntensity} />
      </mesh>
      <mesh position={[0, 3.2, 0]} castShadow>
        <boxGeometry args={[span, 0.4, 0.4]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={emissiveIntensity} />
      </mesh>
    </group>
  );
}

function Decoration({ position, kind }: { position: [number, number, number]; kind: string }) {
  if (kind === "pillar") {
    return (
      <RigidBody type="fixed" colliders="cuboid" position={[position[0], 2, position[2]]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[1.2, 4, 1.2]} />
          <meshStandardMaterial color="#334155" roughness={0.8} />
        </mesh>
      </RigidBody>
    );
  }
  if (kind === "crate") {
    return (
      <RigidBody type="fixed" colliders="cuboid" position={[position[0], 0.6, position[2]]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[1.2, 1.2, 1.2]} />
          <meshStandardMaterial color="#a16207" roughness={0.85} />
        </mesh>
      </RigidBody>
    );
  }
  // cone
  return (
    <RigidBody type="fixed" colliders="hull" position={[position[0], 0.4, position[2]]}>
      <mesh castShadow>
        <coneGeometry args={[0.4, 0.9, 12]} />
        <meshStandardMaterial color="#f97316" roughness={0.7} />
      </mesh>
    </RigidBody>
  );
}

// ---------------------------------------------------------------------------
// Local car
// ---------------------------------------------------------------------------

function RaceCar({
  glbUrl,
  spawn,
  enabled,
  bodyRef,
  anchorRef,
}: {
  glbUrl: string | null;
  spawn: { position: [number, number, number]; rotationY: number };
  enabled: boolean;
  bodyRef: RefObject<RapierRigidBody | null>;
  anchorRef: RefObject<THREE.Object3D | null>;
}) {
  const spawnPos: [number, number, number] = [spawn.position[0], 1.2, spawn.position[2]];
  if (!glbUrl) {
    return (
      <VehicleRig
        rig={getPlaceholderRig()}
        bodyRef={bodyRef}
        anchorRef={anchorRef}
        position={spawnPos}
        rotationY={spawn.rotationY}
        enabled={enabled}
      />
    );
  }
  return (
    <RaceCarModel
      url={glbUrl}
      spawnPos={spawnPos}
      rotationY={spawn.rotationY}
      enabled={enabled}
      bodyRef={bodyRef}
      anchorRef={anchorRef}
    />
  );
}

function RaceCarModel({
  url,
  spawnPos,
  rotationY,
  enabled,
  bodyRef,
  anchorRef,
}: {
  url: string;
  spawnPos: [number, number, number];
  rotationY: number;
  enabled: boolean;
  bodyRef: RefObject<RapierRigidBody | null>;
  anchorRef: RefObject<THREE.Object3D | null>;
}) {
  const gltf = useGLTF(url);
  const { visual, rig } = useMemo(() => {
    const object = gltf.scene.clone(true);
    normalizeOrientation(object);
    applyDoodleStyle(object);
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return { visual: object, rig: deriveRigFromObject(object) };
  }, [gltf.scene]);

  return (
    <VehicleRig
      rig={rig}
      bodyRef={bodyRef}
      anchorRef={anchorRef}
      visual={<primitive object={visual} />}
      position={spawnPos}
      rotationY={rotationY}
      enabled={enabled}
    />
  );
}

// ---------------------------------------------------------------------------
// Lap tracking + camera
// ---------------------------------------------------------------------------

function LapTracker({
  bodyRef,
  gates,
  active,
  progress,
  onGatePass,
}: {
  bodyRef: RefObject<RapierRigidBody | null>;
  gates: Gate[];
  active: boolean;
  progress: RefObject<Progress>;
  onGatePass: () => void;
}) {
  useFrame(() => {
    if (!active) return;
    const body = bodyRef.current;
    if (!body) return;
    const t = body.translation();
    const gate = gates[progress.current.nextGate];
    const dx = t.x - gate.position[0];
    const dz = t.z - gate.position[2];
    if (dx * dx + dz * dz <= GATE_TRIGGER_RADIUS * GATE_TRIGGER_RADIUS) {
      onGatePass();
    }
  });
  return null;
}

/** Broadcasts the local car pose at ~20 Hz for remote ghosts. */
function TransformBroadcaster({
  bodyRef,
  onTransform,
}: {
  bodyRef: RefObject<RapierRigidBody | null>;
  onTransform: (p: Vec3n, q: Quat) => void;
}) {
  const acc = useRef(0);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.05) return;
    acc.current = 0;
    const body = bodyRef.current;
    if (!body) return;
    const t = body.translation();
    const r = body.rotation();
    onTransform([t.x, t.y, t.z], [r.x, r.y, r.z, r.w]);
  });
  return null;
}

/** Slow overview orbit for spectators (no car to follow). */
function SpectatorCamera({ track }: { track: TrackDef }) {
  const { camera } = useThree();
  const view = useMemo(() => {
    const xs = track.gates.map((g) => g.position[0]);
    const zs = track.gates.map((g) => g.position[2]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const radius = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    return { cx, cz, radius };
  }, [track]);
  const target = useMemo(() => new THREE.Vector3(view.cx, 0, view.cz), [view]);

  useFrame((state) => {
    const a = state.clock.elapsedTime * 0.08;
    const dist = view.radius * 1.1 + 20;
    const height = view.radius * 0.7 + 25;
    camera.position.set(view.cx + Math.cos(a) * dist, height, view.cz + Math.sin(a) * dist);
    camera.lookAt(target);
  });
  return null;
}

/**
 * ChaseCamera follows an anchor *inside* the rigid body (the interpolated, render-smoothed
 * transform) rather than the raw physics body — following the raw body makes the whole
 * world appear to vibrate because the mesh is interpolated between fixed physics steps but
 * the camera would step at the physics rate. The anchor's world transform reads a frame
 * behind but stays smooth, which is what matters.
 */
function ChaseCamera({ target }: { target: RefObject<THREE.Object3D | null> }) {
  const { camera } = useThree();
  const carPos = useMemo(() => new THREE.Vector3(), []);
  const carQuat = useMemo(() => new THREE.Quaternion(), []);
  const forward = useMemo(() => new THREE.Vector3(), []);
  const desired = useMemo(() => new THREE.Vector3(), []);
  const lookAt = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame((_, dt) => {
    const anchor = target.current;
    if (!anchor) return;
    anchor.getWorldPosition(carPos);
    anchor.getWorldQuaternion(carQuat);
    forward.set(0, 0, 1).applyQuaternion(carQuat);
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
