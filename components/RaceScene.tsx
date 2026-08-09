"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import {
  Physics,
  RigidBody,
  CuboidCollider,
  useBeforePhysicsStep,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier";
import {
  deriveRigFromObject,
  getPlaceholderRig,
  normalizeOrientation,
} from "@/lib/rig";
import { applyDoodleStyle } from "@/lib/doodle";
import { getTrack, type Gate, type TrackDef, type Vec3 } from "@/lib/tracks";
import { useAutoFullscreen } from "@/lib/fullscreen";
import type { Quat, Standing, Vec3n } from "@/lib/roomTypes";
import { VehicleRig, type RespawnPoint } from "./VehicleRig";
import { RaceHud, type RaceResult } from "./RaceHud";
import { RemoteVehicle, type Snapshot } from "./RemoteVehicle";
import { TouchControls } from "./TouchControls";
import { Minimap } from "./Minimap";
import { AdminMinimap } from "./AdminMinimap";
import { AdminDrivePanel } from "./AdminDrivePanel";
import { GraphicsPanel } from "./GraphicsPanel";
import { CheckpointPanel } from "./CheckpointPanel";
import { resolveVehicleTuning, type VehicleTuning } from "@/lib/vehicleTuning";
import {
  resolveGraphicsSettings,
  sunPosition,
  type GraphicsSettings,
} from "@/lib/graphicsSettings";

export interface RemoteRacer {
  deviceId: string;
  glbUrl: string | null;
  spawnIndex: number;
}

/**
 * RaceScene — a race on a gate track. Client-only (WebGL).
 *
 * The local car is the raycast VehicleRig; laps are counted by driving through the
 * ordered gates (planar proximity). The state machine is waiting → countdown → racing →
 * finished, driven by a shared wall-clock `startAt` so multiplayer clients release the
 * brakes at the same instant. Solo play omits `startAt` and self-schedules a local start.
 */

type Phase = "waiting" | "countdown" | "racing" | "finished";

// View distance: fog fades in with distance and swallows everything past its far edge
// (see graphicsSettings). The ground plane extends past that edge (GROUND_HALF) so its
// edge is never visible — raise them together.
const GROUND_HALF = 600;

// Admin teleport: cast down from this far above the target to reseat the car on whatever
// surface is under the clicked point (uploaded GLB maps have no fixed ground plane).
const TELEPORT_CAST_HEIGHT = 200;

// Authored checkpoint gate: half-width of the opening / crossing trigger, and the vertical
// tolerance for a crossing (keeps overpasses honest).
const CHECKPOINT_RADIUS = 6;
const CHECKPOINT_MAX_HEIGHT_DIFF = 6;

/** An admin-authored checkpoint: the car pose captured when it was dropped. */
interface Checkpoint {
  position: Vec3;
  rotationY: number;
}
interface CheckpointProgress {
  nextIndex: number;
  lastPassed: number;
}

interface Progress {
  nextGate: number;
  lap: number;
  lapStart: number;
  lapTimes: number[];
}

export function RaceScene({
  trackId,
  track: customTrack,
  carGlbUrl,
  laps,
  spawnIndex = 0,
  startAt: startAtMs,
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
  adminMode = false,
}: {
  trackId: string;
  /** Admin-authored track definition; otherwise resolved from the built-in catalogue. */
  track?: TrackDef;
  carGlbUrl: string | null;
  laps: number;
  spawnIndex?: number;
  /**
   * Shared wall-clock start (Date.now() epoch, ms). `null` holds everyone at the grid
   * until the owner's "go" arrives; omit entirely for solo play (local countdown).
   */
  startAt?: number | null;
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
  /** Enables live vehicle controls for custom-map test drives. */
  adminMode?: boolean;
}) {
  useAutoFullscreen();
  const track = useMemo(() => customTrack ?? getTrack(trackId), [customTrack, trackId]);
  const freeDrive = track.gates.length === 0;
  const spawn = track.spawns[spawnIndex % track.spawns.length];
  const chassisRef = useRef<RapierRigidBody>(null);
  const carAnchor = useRef<THREE.Object3D>(null);
  // Admin teleport: the minimap sets a pending world XZ; AdminTeleporter consumes it in the
  // physics step. Once a teleport lands, adminRespawnRef holds the new respawn target.
  const teleportRequestRef = useRef<{ x: number; z: number } | null>(null);
  const adminRespawnRef = useRef<RespawnPoint | null>(null);
  // Admin checkpoint authoring: the ordered loop being dropped, whether order is enforced,
  // and the crossing progress the enforcer tracks (a ref so it lives inside the physics step).
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [enforceOrder, setEnforceOrder] = useState(false);
  const [cpNext, setCpNext] = useState(0);
  const cpProgress = useRef<CheckpointProgress>({ nextIndex: 0, lastPassed: -1 });
  const cpStartPose = useRef<Checkpoint | null>(null);

  // Solo play (prop omitted): self-schedule a local start so practice keeps its 3-2-1.
  const [soloStartAt] = useState<number | null>(() =>
    startAtMs === undefined ? Date.now() + 3200 : null,
  );
  const startEpoch = startAtMs ?? soloStartAt;

  const [phase, setPhase] = useState<Phase>(startEpoch == null ? "waiting" : "countdown");
  const [countdown, setCountdown] = useState(3);
  const [goFlash, setGoFlash] = useState(false);
  const [lap, setLap] = useState(0);
  const [nextGate, setNextGate] = useState(1);
  const [lapTimes, setLapTimes] = useState<number[]>([]);
  const [result, setResult] = useState<RaceResult | null>(null);
  const [tuning, setTuning] = useState<VehicleTuning>(() => resolveVehicleTuning(track.tuning));
  const [graphics, setGraphics] = useState<GraphicsSettings>(() =>
    resolveGraphicsSettings(track.graphics),
  );
  const sunPos = useMemo(() => sunPosition(graphics), [graphics]);
  const [wrongWay, setWrongWay] = useState(false);
  const [raceStartPerf, setRaceStartPerf] = useState<number | null>(null);

  const progress = useRef<Progress>({ nextGate: 1, lap: 0, lapStart: 0, lapTimes: [] });
  const emptyBuffers = useRef<Map<string, Snapshot[]>>(new Map());

  // Countdown driven by the shared wall clock, so every client releases the brakes at
  // the same instant regardless of when its page mounted. A very late join (startEpoch
  // already passed) drops straight into racing with the lap clock backdated to the true
  // start, keeping its times comparable in the standings.
  useEffect(() => {
    if (startEpoch == null) return; // waiting for "go"
    let done = false;
    const tick = () => {
      if (done) return;
      const remaining = startEpoch - Date.now();
      if (remaining > 0) {
        setPhase((p) => (p === "waiting" ? "countdown" : p));
        setCountdown(Math.min(3, Math.ceil(remaining / 1000)));
        return;
      }
      done = true;
      window.clearInterval(id);
      const start = performance.now() + remaining; // backdate by the overshoot
      progress.current.lapStart = start;
      setRaceStartPerf(start);
      setCountdown(0);
      setPhase((p) => (p === "waiting" || p === "countdown" ? "racing" : p));
      setGoFlash(true);
      window.setTimeout(() => setGoFlash(false), 900);
    };
    const id = window.setInterval(tick, 100);
    tick();
    return () => {
      done = true;
      window.clearInterval(id);
    };
  }, [startEpoch]);

  // Resets (manual R / flipped / fell off) return to the last passed gate once the
  // player has actually passed one; before that, back to the grid slot. Read inside
  // the physics step, so it works off the progress ref rather than React state.
  const getRespawn = (): RespawnPoint => {
    // An admin teleport overrides the gate/grid respawn until the next teleport.
    if (adminRespawnRef.current) return adminRespawnRef.current;
    const p = progress.current;
    const total = track.gates.length;
    if (total > 0 && (p.lap > 0 || p.nextGate !== 1)) {
      const g = track.gates[(p.nextGate - 1 + total) % total];
      return {
        position: [g.position[0], g.position[1] + 1.2, g.position[2]],
        rotationY: g.rotationY,
      };
    }
    return {
      position: [spawn.position[0], spawn.position[1] + 1.2, spawn.position[2]],
      rotationY: spawn.rotationY,
    };
  };

  // Persist the panels' live settings onto the custom map so races on it inherit them.
  const savableMap = adminMode && Boolean(customTrack);
  const saveSettings = async (patch: {
    tuning?: VehicleTuning;
    graphics?: GraphicsSettings;
    checkpoints?: Checkpoint[];
  }) => {
    const res = await fetch(`/api/maps/${encodeURIComponent(track.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error("failed to save settings");
  };
  const saveTuning = savableMap ? () => saveSettings({ tuning }) : undefined;
  const saveGraphics = savableMap ? () => saveSettings({ graphics }) : undefined;
  const saveCheckpoints = savableMap ? () => saveSettings({ checkpoints }) : undefined;

  // Drop a checkpoint at the car's current pose (button or the C key).
  const dropCheckpoint = useCallback(() => {
    const body = chassisRef.current;
    if (!body) return;
    const t = body.translation();
    const r = body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const yaw = f.x * f.x + f.z * f.z > 1e-4 ? Math.atan2(f.x, f.z) : 0;
    setCheckpoints((prev) => [...prev, { position: [t.x, t.y, t.z], rotationY: yaw }]);
  }, []);

  useEffect(() => {
    if (!adminMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "KeyC" && !event.repeat) {
        event.preventDefault();
        dropCheckpoint();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adminMode, dropCheckpoint]);

  // Enforcement needs at least one checkpoint, so undoing/clearing to empty exits it.
  const undoCheckpoint = () => {
    setCheckpoints((prev) => prev.slice(0, -1));
    if (checkpoints.length <= 1) setEnforceOrder(false);
  };
  const clearCheckpoints = () => {
    setCheckpoints([]);
    setEnforceOrder(false);
  };

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
        {graphics.fog && (
          <fog attach="fog" args={[track.skyColor, graphics.fogNear, graphics.fogFar]} />
        )}
        <ambientLight intensity={graphics.ambient} />
        <hemisphereLight intensity={graphics.fill} groundColor="#2a2a2a" />
        <directionalLight
          // Remount on resolution change so the shadow map is rebuilt at the new size.
          key={graphics.shadowMapSize}
          castShadow={graphics.shadows}
          position={sunPos}
          intensity={graphics.sunIntensity}
          shadow-mapSize={[graphics.shadowMapSize, graphics.shadowMapSize]}
          shadow-bias={graphics.shadowBias}
          shadow-normalBias={graphics.shadowNormalBias}
          shadow-camera-near={1}
          shadow-camera-far={500}
          shadow-camera-left={-200}
          shadow-camera-right={200}
          shadow-camera-top={200}
          shadow-camera-bottom={-200}
        />

        <Physics>
          <TrackView track={track} nextGate={nextGate} />

          {adminMode && checkpoints.length > 0 && (
            <CheckpointMarkers
              checkpoints={checkpoints}
              highlight={enforceOrder ? cpNext : checkpoints.length - 1}
              accent={track.accent}
            />
          )}

          {!spectator && (
            <>
              <Suspense fallback={null}>
                <RaceCar
                  glbUrl={carGlbUrl}
                  spawn={spawn}
                  enabled={phase === "racing"}
                  bodyRef={chassisRef}
                  anchorRef={carAnchor}
                  tuning={tuning}
                  getRespawn={getRespawn}
                />
              </Suspense>
              {!freeDrive && (
                <LapTracker
                  bodyRef={chassisRef}
                  gates={track.gates}
                  active={phase === "racing"}
                  progress={progress}
                  onGatePass={onGatePass}
                  onWrongWay={setWrongWay}
                />
              )}
              {onTransform && <TransformBroadcaster bodyRef={chassisRef} onTransform={onTransform} />}
              {adminMode && (
                <AdminTeleporter
                  chassisRef={chassisRef}
                  requestRef={teleportRequestRef}
                  respawnRef={adminRespawnRef}
                  fallbackY={spawn.position[1]}
                />
              )}
              {adminMode && enforceOrder && checkpoints.length > 0 && (
                <CheckpointEnforcer
                  chassisRef={chassisRef}
                  checkpoints={checkpoints}
                  progressRef={cpProgress}
                  startPoseRef={cpStartPose}
                  onProgress={setCpNext}
                />
              )}
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

        {spectator ? (
          <SpectatorCamera track={track} />
        ) : (
          <ChaseCamera target={carAnchor} bodyRef={chassisRef} />
        )}
      </Canvas>

      <RaceHud
        phase={phase}
        countdown={countdown}
        goFlash={goFlash}
        lap={lap}
        totalLaps={laps}
        startAt={raceStartPerf}
        running={phase === "racing"}
        lapTimes={lapTimes}
        result={result}
        standings={standings}
        selfDeviceId={selfDeviceId}
        spectator={spectator}
        freeDrive={freeDrive}
        wrongWay={wrongWay}
        exitLabel={exitLabel}
        onExit={onExit}
      />
      {!spectator && <SpeedMeter bodyRef={chassisRef} />}
      {!spectator && <TouchControls />}
      {adminMode && <AdminDrivePanel tuning={tuning} onChange={setTuning} onSave={saveTuning} />}
      {adminMode && (
        <GraphicsPanel settings={graphics} onChange={setGraphics} onSave={saveGraphics} />
      )}
      {adminMode && !spectator && (
        <CheckpointPanel
          count={checkpoints.length}
          enforce={enforceOrder}
          onEnforceChange={setEnforceOrder}
          onDrop={dropCheckpoint}
          onUndo={undoCheckpoint}
          onClear={clearCheckpoints}
          onSave={saveCheckpoints}
        />
      )}
      {adminMode && !spectator && (
        <AdminMinimap
          track={track}
          selfBody={chassisRef}
          onTeleport={(x, z) => {
            teleportRequestRef.current = { x, z };
          }}
        />
      )}
      {!freeDrive && (
        <Minimap track={track} selfBody={chassisRef} remoteBuffers={remoteBuffers ?? emptyBuffers} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Track + gates
// ---------------------------------------------------------------------------

function TrackView({ track, nextGate }: { track: TrackDef; nextGate: number }) {
  return (
    <group>
      {!track.modelUrl && (
        <RigidBody type="fixed" friction={1.1} colliders={false}>
          <CuboidCollider args={[GROUND_HALF, 0.1, GROUND_HALF]} position={[0, -0.1, 0]} />
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[GROUND_HALF * 2, GROUND_HALF * 2]} />
            <meshStandardMaterial color={track.groundColor} roughness={1} />
          </mesh>
        </RigidBody>
      )}

      {track.modelUrl && (
        <Suspense fallback={null}>
          <MapModel url={track.modelUrl} scale={track.modelScale ?? 1} />
        </Suspense>
      )}

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

function MapModel({ url, scale }: { url: string; scale: number }) {
  const gltf = useGLTF(url);
  const scene = useMemo(() => {
    const clone = gltf.scene.clone(true);
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return clone;
  }, [gltf.scene]);

  return (
    <RigidBody type="fixed" colliders="trimesh">
      <primitive object={scene} scale={scale} />
    </RigidBody>
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
  tuning,
  getRespawn,
}: {
  glbUrl: string | null;
  spawn: { position: [number, number, number]; rotationY: number };
  enabled: boolean;
  bodyRef: RefObject<RapierRigidBody | null>;
  anchorRef: RefObject<THREE.Object3D | null>;
  tuning: VehicleTuning;
  getRespawn: () => RespawnPoint;
}) {
  const spawnPos: [number, number, number] = [
    spawn.position[0],
    spawn.position[1] + 1.2,
    spawn.position[2],
  ];
  if (!glbUrl) {
    return (
      <VehicleRig
        rig={getPlaceholderRig()}
        bodyRef={bodyRef}
        anchorRef={anchorRef}
        position={spawnPos}
        rotationY={spawn.rotationY}
        enabled={enabled}
        tuning={tuning}
        getRespawn={getRespawn}
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
      tuning={tuning}
      getRespawn={getRespawn}
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
  tuning,
  getRespawn,
}: {
  url: string;
  spawnPos: [number, number, number];
  rotationY: number;
  enabled: boolean;
  bodyRef: RefObject<RapierRigidBody | null>;
  anchorRef: RefObject<THREE.Object3D | null>;
  tuning: VehicleTuning;
  getRespawn: () => RespawnPoint;
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
      tuning={tuning}
      getRespawn={getRespawn}
    />
  );
}

// ---------------------------------------------------------------------------
// Lap tracking + camera
// ---------------------------------------------------------------------------

/** Seconds of sustained driving away from the next gate before "WRONG WAY" shows. */
const WRONG_WAY_AFTER_S = 1.5;
/** Vertical tolerance for a gate crossing (keeps overpasses on custom maps honest). */
const GATE_MAX_HEIGHT_DIFF = 6;

/**
 * Counts gates by an actual plane crossing: the car's position, expressed in the
 * gate's local frame (+Z = travel direction), must move from behind the gate plane
 * to on/past it within the post span — not merely come near the gate's centre. The
 * crossing point is interpolated between frames so diagonal passes stay accurate.
 */
function LapTracker({
  bodyRef,
  gates,
  active,
  progress,
  onGatePass,
  onWrongWay,
}: {
  bodyRef: RefObject<RapierRigidBody | null>;
  gates: Gate[];
  active: boolean;
  progress: RefObject<Progress>;
  onGatePass: () => void;
  onWrongWay: (wrong: boolean) => void;
}) {
  const prev = useRef<{ gate: number; z: number; x: number } | null>(null);
  const wrongForRef = useRef(0);
  const wrongShownRef = useRef(false);

  useFrame((_, dt) => {
    if (!active) {
      prev.current = null;
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    const t = body.translation();
    const gi = progress.current.nextGate;
    const gate = gates[gi];

    // Car position in the gate's local frame: forward = (sin r, cos r) on XZ.
    const sin = Math.sin(gate.rotationY);
    const cos = Math.cos(gate.rotationY);
    const dx = t.x - gate.position[0];
    const dz = t.z - gate.position[2];
    const localZ = dx * sin + dz * cos;
    const localX = dx * cos - dz * sin;

    const p = prev.current;
    if (p && p.gate === gi && p.z < 0 && localZ >= 0) {
      const frac = p.z / (p.z - localZ);
      const xAtCrossing = p.x + (localX - p.x) * frac;
      if (
        Math.abs(xAtCrossing) <= gate.width &&
        Math.abs(t.y - gate.position[1]) < GATE_MAX_HEIGHT_DIFF
      ) {
        onGatePass();
      }
    }
    prev.current = { gate: gi, z: localZ, x: localX };

    // Wrong-way: sustained meaningful speed away from the next gate.
    const vel = body.linvel();
    const speed = Math.hypot(vel.x, vel.z);
    const dist = Math.hypot(dx, dz) || 1;
    const closingSpeed = -(vel.x * dx + vel.z * dz) / dist; // + = toward the gate
    wrongForRef.current = speed > 4 && closingSpeed < -2 ? wrongForRef.current + dt : 0;
    const wrong = wrongForRef.current > WRONG_WAY_AFTER_S;
    if (wrong !== wrongShownRef.current) {
      wrongShownRef.current = wrong;
      onWrongWay(wrong);
    }
  });
  return null;
}

/**
 * Speed readout for the local car. Reads the body velocity on its own rAF loop and
 * writes straight to a DOM node, so it never triggers React re-renders.
 */
function SpeedMeter({ bodyRef }: { bodyRef: RefObject<RapierRigidBody | null> }) {
  const speedEl = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const body = bodyRef.current;
      const el = speedEl.current;
      if (body && el) {
        const v = body.linvel();
        el.textContent = String(Math.round(Math.hypot(v.x, v.z) * 3.6));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bodyRef]);

  return (
    <div className="race-speed pointer-events-none absolute z-10 flex items-baseline gap-1.5 rounded-md bg-black/45 px-3 py-1.5 font-mono text-white backdrop-blur">
      <span ref={speedEl} className="text-2xl font-bold tabular-nums">
        0
      </span>
      <span className="text-xs opacity-70">km/h</span>
    </div>
  );
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

/**
 * AdminTeleporter — consumes a pending minimap teleport request in the physics step.
 *
 * Runs inside <Physics> so it can raycast the world: it drops the car onto whatever surface
 * sits under the clicked XZ (falling back to the spawn height on a miss), preserves the car's
 * current heading, zeroes its velocity, and records the landing as the new respawn point so
 * manual/auto resets return there.
 */
function AdminTeleporter({
  chassisRef,
  requestRef,
  respawnRef,
  fallbackY,
}: {
  chassisRef: RefObject<RapierRigidBody | null>;
  requestRef: RefObject<{ x: number; z: number } | null>;
  respawnRef: RefObject<RespawnPoint | null>;
  fallbackY: number;
}) {
  const { world, rapier } = useRapier();
  const quat = useMemo(() => new THREE.Quaternion(), []);
  const forward = useMemo(() => new THREE.Vector3(), []);

  useBeforePhysicsStep(() => {
    const req = requestRef.current;
    const body = chassisRef.current;
    if (!req || !body) return;
    requestRef.current = null;

    const originY = fallbackY + TELEPORT_CAST_HEIGHT;
    const ray = new rapier.Ray({ x: req.x, y: originY, z: req.z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, TELEPORT_CAST_HEIGHT * 3, true, undefined, undefined, undefined, body);
    const y = hit ? originY - hit.timeOfImpact + 1.1 : fallbackY + 1.2;

    // Keep the current heading (flattened onto the ground).
    const rot = body.rotation();
    quat.set(rot.x, rot.y, rot.z, rot.w);
    forward.set(0, 0, 1).applyQuaternion(quat);
    const yaw = forward.x * forward.x + forward.z * forward.z > 1e-4 ? Math.atan2(forward.x, forward.z) : 0;
    const half = yaw / 2;

    body.setTranslation({ x: req.x, y, z: req.z }, true);
    body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    respawnRef.current = { position: [req.x, y, req.z], rotationY: yaw };
  });

  return null;
}

/**
 * CheckpointMarkers — admin-only gate posts for the authored checkpoint loop. Purely visual
 * (no colliders); the `highlight` post glows so the current target reads at a glance.
 */
function CheckpointMarkers({
  checkpoints,
  highlight,
  accent,
}: {
  checkpoints: Checkpoint[];
  highlight: number;
  accent: string;
}) {
  return (
    <group>
      {checkpoints.map((cp, i) => {
        const isHighlight = i === highlight;
        const color = i === 0 ? "#f8fafc" : accent;
        return (
          <group key={i} position={cp.position} rotation={[0, cp.rotationY, 0]}>
            {[CHECKPOINT_RADIUS, -CHECKPOINT_RADIUS].map((x) => (
              <mesh key={x} position={[x, 1.6, 0]}>
                <boxGeometry args={[0.35, 3.2, 0.35]} />
                <meshStandardMaterial
                  color={color}
                  emissive={isHighlight ? accent : "#000000"}
                  emissiveIntensity={isHighlight ? 1 : 0}
                  transparent
                  opacity={0.85}
                />
              </mesh>
            ))}
            <mesh position={[0, 3.2, 0]}>
              <boxGeometry args={[CHECKPOINT_RADIUS * 2 + 0.35, 0.35, 0.35]} />
              <meshStandardMaterial
                color={color}
                emissive={isHighlight ? accent : "#000000"}
                emissiveIntensity={isHighlight ? 1 : 0}
                transparent
                opacity={0.85}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/**
 * CheckpointEnforcer — enforces the authored order during a test drive.
 *
 * On mount it captures the car's pose as a safe start and resets progress. Each physics step
 * it detects plane crossings of every checkpoint (interpolated, within the post span): crossing
 * the expected next advances progress; crossing anything else out of sequence teleports the car
 * back to the last correct checkpoint (or the start) with velocity zeroed, so a bad line can't
 * loop forever. Re-crossing the last-passed checkpoint is allowed (backing up).
 */
function CheckpointEnforcer({
  chassisRef,
  checkpoints,
  progressRef,
  startPoseRef,
  onProgress,
}: {
  chassisRef: RefObject<RapierRigidBody | null>;
  checkpoints: Checkpoint[];
  progressRef: RefObject<CheckpointProgress>;
  startPoseRef: RefObject<Checkpoint | null>;
  onProgress: (next: number) => void;
}) {
  const prev = useRef<({ z: number; x: number } | null)[]>([]);
  const quat = useMemo(() => new THREE.Quaternion(), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);

  // Enabling enforcement (mount) captures a start pose and resets the run to the first gate.
  useEffect(() => {
    progressRef.current = { nextIndex: 0, lastPassed: -1 };
    prev.current = [];
    const body = chassisRef.current;
    if (body) {
      const t = body.translation();
      const r = body.rotation();
      quat.set(r.x, r.y, r.z, r.w);
      fwd.set(0, 0, 1).applyQuaternion(quat);
      const yaw = fwd.x * fwd.x + fwd.z * fwd.z > 1e-4 ? Math.atan2(fwd.x, fwd.z) : 0;
      startPoseRef.current = { position: [t.x, t.y, t.z], rotationY: yaw };
    }
    onProgress(0);
  }, [chassisRef, progressRef, startPoseRef, onProgress, quat, fwd]);

  const teleport = (target: Checkpoint) => {
    const body = chassisRef.current;
    if (!body) return;
    const half = target.rotationY / 2;
    body.setTranslation(
      { x: target.position[0], y: target.position[1], z: target.position[2] },
      true,
    );
    body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  };

  useBeforePhysicsStep(() => {
    const body = chassisRef.current;
    const n = checkpoints.length;
    if (!body || n === 0) return;
    if (prev.current.length !== n) prev.current = new Array(n).fill(null);

    const t = body.translation();
    const prog = progressRef.current;

    for (let i = 0; i < n; i++) {
      const cp = checkpoints[i];
      const sin = Math.sin(cp.rotationY);
      const cos = Math.cos(cp.rotationY);
      const dx = t.x - cp.position[0];
      const dz = t.z - cp.position[2];
      const localZ = dx * sin + dz * cos;
      const localX = dx * cos - dz * sin;

      const p = prev.current[i];
      let crossed = false;
      if (p && p.z < 0 && localZ >= 0) {
        const frac = p.z / (p.z - localZ);
        const xAtCrossing = p.x + (localX - p.x) * frac;
        crossed =
          Math.abs(xAtCrossing) <= CHECKPOINT_RADIUS &&
          Math.abs(t.y - cp.position[1]) < CHECKPOINT_MAX_HEIGHT_DIFF;
      }
      prev.current[i] = { z: localZ, x: localX };

      if (!crossed) continue;
      if (i === prog.nextIndex) {
        prog.lastPassed = i;
        prog.nextIndex = (i + 1) % n;
        onProgress(prog.nextIndex);
      } else if (i !== prog.lastPassed) {
        // Out of order: send the car back and reseed crossings so it can't re-trigger.
        const target = prog.lastPassed >= 0 ? checkpoints[prog.lastPassed] : startPoseRef.current;
        if (target) teleport(target);
        prev.current = new Array(n).fill(null);
        break;
      }
    }
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

/** FOV widens and the camera hangs back as speed builds — the sensation of speed. */
const CAMERA_BASE_FOV = 60;
const CAMERA_MAX_EXTRA_FOV = 13;
const CAMERA_BASE_DIST = 8;
const CAMERA_MAX_EXTRA_DIST = 2;
const CAMERA_SPEED_REF = 30; // m/s that maps to the full effect

/**
 * ChaseCamera follows an anchor *inside* the rigid body (the interpolated, render-smoothed
 * transform) rather than the raw physics body — following the raw body makes the whole
 * world appear to vibrate because the mesh is interpolated between fixed physics steps but
 * the camera would step at the physics rate. The anchor's world transform reads a frame
 * behind but stays smooth, which is what matters.
 *
 * The follow direction is the car's heading flattened onto the ground plane, so ramps and
 * flips don't pitch the camera into the floor; speed (from the body) stretches FOV and
 * follow distance for a sense of pace.
 */
function ChaseCamera({
  target,
  bodyRef,
}: {
  target: RefObject<THREE.Object3D | null>;
  bodyRef: RefObject<RapierRigidBody | null>;
}) {
  const { camera } = useThree();
  const carPos = useMemo(() => new THREE.Vector3(), []);
  const carQuat = useMemo(() => new THREE.Quaternion(), []);
  const forward = useMemo(() => new THREE.Vector3(), []);
  const lastForward = useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const desired = useMemo(() => new THREE.Vector3(), []);
  const lookAt = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame((_, dt) => {
    const anchor = target.current;
    if (!anchor) return;
    anchor.getWorldPosition(carPos);
    anchor.getWorldQuaternion(carQuat);
    forward.set(0, 0, 1).applyQuaternion(carQuat).setY(0);
    if (forward.lengthSq() < 1e-4) {
      forward.copy(lastForward); // car is vertical mid-tumble; hold the last heading
    } else {
      forward.normalize();
      lastForward.copy(forward);
    }

    const body = bodyRef.current;
    let speedT = 0;
    if (body) {
      const v = body.linvel();
      speedT = THREE.MathUtils.clamp(Math.hypot(v.x, v.z) / CAMERA_SPEED_REF, 0, 1);
    }
    const dist = CAMERA_BASE_DIST + CAMERA_MAX_EXTRA_DIST * speedT;
    desired.copy(carPos).addScaledVector(forward, -dist).addScaledVector(up, 4 + 0.6 * speedT);

    // A respawn teleports the car across the map; snap rather than fly the damped
    // camera through 200 m of fog.
    if (camera.position.distanceTo(desired) > 30) {
      camera.position.copy(desired);
    }

    const lambda = 4;
    camera.position.set(
      THREE.MathUtils.damp(camera.position.x, desired.x, lambda, dt),
      THREE.MathUtils.damp(camera.position.y, desired.y, lambda, dt),
      THREE.MathUtils.damp(camera.position.z, desired.z, lambda, dt),
    );
    lookAt.copy(carPos).addScaledVector(up, 0.8);
    camera.lookAt(lookAt);

    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      const targetFov = CAMERA_BASE_FOV + CAMERA_MAX_EXTRA_FOV * speedT * speedT;
      setCameraFov(cam, THREE.MathUtils.damp(cam.fov, targetFov, 3, dt));
    }
  });

  return null;
}

/**
 * Drive a PerspectiveCamera's fov through setFocalLength (which assigns .fov and
 * refreshes the projection matrix) — method-call mutation only, per the lint rules.
 */
function setCameraFov(cam: THREE.PerspectiveCamera, fov: number): void {
  if (Math.abs(fov - cam.fov) < 0.01) return;
  const focal = (0.5 * cam.getFilmHeight()) / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  cam.setFocalLength(focal);
}
