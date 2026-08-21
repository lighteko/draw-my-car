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
import type { AuthoredPose, Gate, TrackDef, Vec3 } from "@/lib/tracks";
import { useAutoFullscreen } from "@/lib/fullscreen";
import {
  isMuted,
  playCountdownBeep,
  playFinishFanfare,
  playGoHorn,
  playWrongWay,
  setEngineSpeed,
  setMuted,
  stopEngine,
  unlockAudio,
} from "@/lib/audio";
import type { Quat, Standing, Vec3n } from "@/lib/roomTypes";
import { VehicleRig, type RespawnPoint } from "./VehicleRig";
import { RaceHud, type LapDelta, type RaceResult } from "./RaceHud";
import { RemoteVehicle, type Snapshot } from "./RemoteVehicle";
import { TouchControls } from "./TouchControls";
import { Minimap } from "./Minimap";
import { AdminMinimap } from "./AdminMinimap";
import { AdminDrivePanel } from "./AdminDrivePanel";
import { GraphicsPanel } from "./GraphicsPanel";
import { LayoutPanel } from "./LayoutPanel";
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

// Guidance arrow: how far above the car it floats, how many gates ahead it averages, and the
// weight each of those gets. Aiming at just the next gate makes the arrow flick around as the
// car passes it; blending the next three points it down the route instead — measured against
// the 188-gate map, the worst single-frame swing drops from ~65° to ~27°, which the damping
// below then spreads over several frames. A gate closer than ARROW_SKIP_RADIUS is dropped from
// the blend — at that range its bearing is mostly noise.
const ARROW_HEIGHT = 2.4;

// Spectator chase framing — further back and higher than the driver's own camera, because a
// spectator is reading the situation rather than steering through it.
const SPECTATOR_CHASE_DIST = 11;
const SPECTATOR_CHASE_HEIGHT = 5;
const ARROW_WEIGHTS = [1, 0.8, 0.5];
const ARROW_SKIP_RADIUS = 3;

// Start/finish archway: post height and thickness, the checkered banner across the top, its
// rows of checks, and how far below the authored gate pose the road actually is (poses are
// captured at chassis height).
const POST_HEIGHT = 4.2;
const POST_THICKNESS = 0.45;
const BANNER_HEIGHT = 1.2;
const CHECKER_ROWS = 2;
const START_GATE_DROP = 1;

// Authored checkpoint gate: half-width of the opening / crossing trigger, and the vertical
// tolerance for a crossing (keeps overpasses honest).
const CHECKPOINT_RADIUS = 6;
const CHECKPOINT_MAX_HEIGHT_DIFF = 6;

/** An admin-authored checkpoint: the car pose captured when it was dropped. */
type Checkpoint = AuthoredPose;
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
  track,
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
  isOwner = false,
  onRematch,
  rematching = false,
}: {
  /** The admin-authored map to race on, resolved by the page from /api/maps. */
  track: TrackDef;
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
  /** Total race time plus every lap split, so the caller can report a best lap. */
  onFinished?: (totalMs: number, lapTimes: number[]) => void;
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
  /** Only the room owner sees the results-card rematch button. */
  isOwner?: boolean;
  onRematch?: () => void;
  rematching?: boolean;
}) {
  useAutoFullscreen();
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
  // Seeded from the loop the map already has. Without this the panel would open empty on every
  // visit and the next "save route" would replace the authored loop with whatever was dropped
  // in this session — silently wiping the map's checkpoints.
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>(() =>
    track.gates.map((gate) => ({ position: gate.position, rotationY: gate.rotationY })),
  );
  const [enforceOrder, setEnforceOrder] = useState(false);
  const [cpNext, setCpNext] = useState(0);
  const cpProgress = useRef<CheckpointProgress>({ nextIndex: 0, lastPassed: -1 });
  const cpStartPose = useRef<Checkpoint | null>(null);
  // Admin start-grid authoring: the pose slot 0 will sit on, seeded from what the map
  // already has saved so the panel opens showing the current start.
  const [spawnPose, setSpawnPose] = useState<AuthoredPose | null>(track.spawnOrigin ?? null);

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
  // The gates the guidance arrow blends: the next one and the couple after it, wrapping the loop.
  const arrowTargets = useMemo(() => {
    const total = track.gates.length;
    if (total === 0) return [];
    return ARROW_WEIGHTS.slice(0, total).map(
      (_, i) => track.gates[(nextGate + i) % total].position,
    );
  }, [track.gates, nextGate]);
  // Spectators pick a racer to follow; null means the overview orbit.
  const [watchIndex, setWatchIndex] = useState<number | null>(null);
  const watchable = useMemo(
    () =>
      remotes.map((remote) => ({
        deviceId: remote.deviceId,
        name:
          standings.find((entry) => entry.deviceId === remote.deviceId)?.username ??
          remote.deviceId.slice(0, 6),
      })),
    [remotes, standings],
  );
  const watching =
    watchIndex !== null && watchable.length > 0
      ? watchable[watchIndex % watchable.length]
      : null;
  const cycleWatch = useCallback(
    (step: number) => {
      setWatchIndex((current) => {
        if (watchable.length === 0) return null;
        // Cycles through the racers and then back out to the overview, so a spectator can
        // always get the wide shot without hunting for a separate control.
        const next = current === null ? (step > 0 ? 0 : watchable.length - 1) : current + step;
        if (next < 0 || next >= watchable.length) return null;
        return next;
      });
    },
    [watchable.length],
  );

  const [wrongWay, setWrongWay] = useState(false);
  // Lazy init rather than a setState in the effect below: the scene is client-only, so the
  // stored preference is readable on the first render.
  const [muted, setMutedState] = useState(() => isMuted());

  // Browsers only allow audio after a gesture, and a race can start from a keypress as
  // easily as a tap — so unlock on whichever comes first, once.
  useEffect(() => {
    const unlock = () => void unlockAudio();
    const options = { once: true } as const;
    window.addEventListener("pointerdown", unlock, options);
    window.addEventListener("keydown", unlock, options);
    void unlockAudio(); // already-unlocked contexts (a same-tab replay) need no gesture
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // The warning tone rides the same state the HUD banner does, so it fires once per episode.
  useEffect(() => {
    if (wrongWay) playWrongWay();
  }, [wrongWay]);

  const toggleMuted = useCallback(() => {
    setMutedState((current) => {
      const next = !current;
      setMuted(next);
      return next;
    });
    void unlockAudio();
  }, []);

  // Shown briefly after a wrong-way reset so the teleport is explained, not just felt.
  const [resetNotice, setResetNotice] = useState(false);
  const resetNoticeTimer = useRef(0);
  const showResetNotice = useCallback(() => {
    setResetNotice(true);
    window.clearTimeout(resetNoticeTimer.current);
    resetNoticeTimer.current = window.setTimeout(() => setResetNotice(false), 2200);
  }, []);
  useEffect(() => () => window.clearTimeout(resetNoticeTimer.current), []);
  const [raceStartPerf, setRaceStartPerf] = useState<number | null>(null);

  // Best-lap delta: shown briefly after each lap completes, then cleared. The first lap has
  // nothing to compare against, so it never sets this.
  const [lapDelta, setLapDelta] = useState<LapDelta | null>(null);
  const lapDeltaTimer = useRef(0);
  const showLapDelta = useCallback((ms: number) => {
    setLapDelta({ ms });
    window.clearTimeout(lapDeltaTimer.current);
    lapDeltaTimer.current = window.setTimeout(() => setLapDelta(null), 2200);
  }, []);
  useEffect(() => () => window.clearTimeout(lapDeltaTimer.current), []);

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
        const next = Math.min(3, Math.ceil(remaining / 1000));
        setCountdown((current) => {
          if (next !== current && next > 0) playCountdownBeep();
          return next;
        });
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
      playGoHorn();
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

  // Persist the panels' live settings onto the map so races on it inherit them.
  const savableMap = adminMode;
  const saveSettings = async (patch: {
    tuning?: VehicleTuning;
    graphics?: GraphicsSettings;
    checkpoints?: Checkpoint[];
    spawn?: AuthoredPose | null;
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
  const saveSpawn = savableMap ? () => saveSettings({ spawn: spawnPose }) : undefined;

  // The car's current pose, flattened onto the ground plane. Both authoring tools capture
  // the same thing: where the car is and which way it points.
  const capturePose = useCallback((): AuthoredPose | null => {
    const body = chassisRef.current;
    if (!body) return null;
    const t = body.translation();
    const r = body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const yaw = f.x * f.x + f.z * f.z > 1e-4 ? Math.atan2(f.x, f.z) : 0;
    return { position: [t.x, t.y, t.z], rotationY: yaw };
  }, []);

  // Drop a checkpoint at the car's current pose (button or the C key).
  const dropCheckpoint = useCallback(() => {
    const pose = capturePose();
    if (pose) setCheckpoints((prev) => [...prev, pose]);
  }, [capturePose]);

  // Set the start grid at the car's current pose (button or the G key). It also becomes the
  // respawn target, so a reset from here drops back onto the new start line.
  const setSpawnHere = useCallback(() => {
    const pose = capturePose();
    if (!pose) return;
    setSpawnPose(pose);
    adminRespawnRef.current = { position: pose.position, rotationY: pose.rotationY };
  }, [capturePose]);

  useEffect(() => {
    if (!adminMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.code === "KeyC") {
        event.preventDefault();
        dropCheckpoint();
      } else if (event.code === "KeyG") {
        event.preventDefault();
        setSpawnHere();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adminMode, dropCheckpoint, setSpawnHere]);

  // Enforcement needs at least one checkpoint, so undoing/clearing to empty exits it.
  const undoCheckpoint = () => {
    setCheckpoints((prev) => prev.slice(0, -1));
    if (checkpoints.length <= 1) setEnforceOrder(false);
  };
  // Confirmed, because the list now opens seeded with the map's saved loop — clearing it and
  // saving is how a route gets thrown away.
  const clearCheckpoints = () => {
    if (checkpoints.length > 0 && !window.confirm(`Clear all ${checkpoints.length} checkpoints?`)) {
      return;
    }
    setCheckpoints([]);
    setEnforceOrder(false);
  };

  const onGatePass = () => {
    const p = progress.current;
    const total = track.gates.length;
    if (p.nextGate === 0) {
      const now = performance.now();
      const lapTime = now - p.lapStart;
      // Best-lap delta, judged against every prior lap — computed before this lap joins
      // lapTimes, so a first lap (nothing to compare against) never shows one.
      if (p.lapTimes.length > 0) {
        showLapDelta(lapTime - Math.min(...p.lapTimes));
      }
      p.lap += 1;
      p.lapTimes.push(lapTime);
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
        playFinishFanfare();
        onFinished?.(totalMs, [...p.lapTimes]);
      }
    } else {
      p.nextGate = (p.nextGate + 1) % total;
      setNextGate(p.nextGate);
      onProgress?.(p.lap, p.nextGate);
    }
  };

  return (
    <div className="relative h-dvh w-full touch-none overflow-hidden bg-[#17110b]">
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
          <TrackView track={track} />

          {!freeDrive && <StartGate gate={track.gates[0]} />}

          {adminMode && spawnPose && <SpawnMarker pose={spawnPose} accent={track.accent} />}

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
                <DirectionArrow bodyRef={chassisRef} targets={arrowTargets} />
              )}
              {!freeDrive && (
                <LapTracker
                  bodyRef={chassisRef}
                  gates={track.gates}
                  active={phase === "racing"}
                  progress={progress}
                  onGatePass={onGatePass}
                  onWrongWay={setWrongWay}
                  onReset={showResetNotice}
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
          <SpectatorCamera
            track={track}
            remoteBuffers={remoteBuffers ?? emptyBuffers}
            watchDeviceId={watching?.deviceId ?? null}
          />
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
        lapDelta={lapDelta}
        result={result}
        standings={standings}
        selfDeviceId={selfDeviceId}
        spectator={spectator}
        freeDrive={freeDrive}
        wrongWay={wrongWay}
        resetNotice={resetNotice}
        muted={muted}
        onToggleMuted={toggleMuted}
        exitLabel={exitLabel}
        onExit={onExit}
        isOwner={isOwner}
        onRematch={onRematch}
        rematching={rematching}
      />
      {spectator && watchable.length > 0 && (
        <div className="race-watch absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2">
          <button
            type="button"
            aria-label="이전 참가자"
            onClick={() => cycleWatch(-1)}
            className="touch-target flex items-center justify-center rounded-full bg-black/55 px-3 text-white backdrop-blur transition hover:bg-black/75"
          >
            ‹
          </button>
          <div className="min-w-36 rounded-full bg-black/55 px-4 py-2 text-center text-sm text-white backdrop-blur">
            {watching ? watching.name : "전체 보기"}
          </div>
          <button
            type="button"
            aria-label="다음 참가자"
            onClick={() => cycleWatch(1)}
            className="touch-target flex items-center justify-center rounded-full bg-black/55 px-3 text-white backdrop-blur transition hover:bg-black/75"
          >
            ›
          </button>
        </div>
      )}

      {!spectator && <SpeedMeter bodyRef={chassisRef} />}
      {!spectator && <TouchControls />}
      {adminMode && <AdminDrivePanel tuning={tuning} onChange={setTuning} onSave={saveTuning} />}
      {adminMode && (
        <GraphicsPanel settings={graphics} onChange={setGraphics} onSave={saveGraphics} />
      )}
      {adminMode && !spectator && (
        <LayoutPanel
          count={checkpoints.length}
          enforce={enforceOrder}
          hasSpawn={spawnPose !== null}
          onEnforceChange={setEnforceOrder}
          onDrop={dropCheckpoint}
          onUndo={undoCheckpoint}
          onClear={clearCheckpoints}
          onSetSpawn={setSpawnHere}
          onClearSpawn={() => setSpawnPose(null)}
          onSave={saveCheckpoints}
          onSaveSpawn={saveSpawn}
        />
      )}
      {adminMode && !spectator && (
        <AdminMinimap
          track={track}
          spawn={spawnPose}
          selfBody={chassisRef}
          onTeleport={(x, z) => {
            teleportRequestRef.current = { x, z };
          }}
        />
      )}
      {!freeDrive && (
        <Minimap
          track={track}
          selfBody={chassisRef}
          remoteBuffers={remoteBuffers ?? emptyBuffers}
          nextGateIndex={nextGate}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Track + gates
// ---------------------------------------------------------------------------

/**
 * TrackView — the ground/environment and its props. Gates are deliberately not drawn: players
 * are guided by the arrow over the car, and admins see the loop through CheckpointMarkers,
 * which shows the working checkpoint list rather than the last saved one.
 */
function TrackView({ track }: { track: TrackDef }) {
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
/** …and how long before the car is put back on the last gate it passed. */
const WRONG_WAY_RESET_S = 3;
/** Clearance above the gate pose on that reset, so the car never lands inside the road. */
const WRONG_WAY_RESET_LIFT = 0.3;
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
  onReset,
}: {
  bodyRef: RefObject<RapierRigidBody | null>;
  gates: Gate[];
  active: boolean;
  progress: RefObject<Progress>;
  onGatePass: () => void;
  onWrongWay: (wrong: boolean) => void;
  onReset: () => void;
}) {
  const prev = useRef<{ gate: number; z: number; x: number } | null>(null);
  const wrongForRef = useRef(0);
  const wrongShownRef = useRef(false);
  const pendingResetRef = useRef<Gate | null>(null);

  // The wrong-way reset is decided in useFrame but applied here, inside the physics step,
  // like every other teleport in this scene — moving a body mid-frame would race the
  // vehicle controller that runs on the same step.
  useBeforePhysicsStep(() => {
    const target = pendingResetRef.current;
    const body = bodyRef.current;
    if (!target || !body) return;
    pendingResetRef.current = null;
    const half = target.rotationY / 2;
    body.setTranslation(
      {
        x: target.position[0],
        y: target.position[1] + WRONG_WAY_RESET_LIFT,
        z: target.position[2],
      },
      true,
    );
    body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  });

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

    // Keep it up long enough and the car is put back on the last gate it actually passed,
    // facing the right way. The lap counter is untouched: `nextGate` is still the gate that
    // was being driven to, so the recovery costs time and nothing else.
    if (wrongForRef.current > WRONG_WAY_RESET_S) {
      pendingResetRef.current = gates[(gi - 1 + gates.length) % gates.length];
      onReset();
      wrongForRef.current = 0;
      prev.current = null; // the jump itself must not read as a gate crossing
      if (wrongShownRef.current) {
        wrongShownRef.current = false;
        onWrongWay(false);
      }
      return;
    }

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
      if (body) {
        const v = body.linvel();
        const kmh = Math.hypot(v.x, v.z) * 3.6;
        if (el) el.textContent = String(Math.round(kmh));
        // Reuse this loop for the engine note rather than adding a second rAF.
        setEngineSpeed(kmh);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      stopEngine();
    };
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
    const hit = world.castRay(
      ray,
      TELEPORT_CAST_HEIGHT * 3,
      true,
      rapier.QueryFilterFlags.EXCLUDE_SENSORS, // land on the map, not on another car
      undefined,
      undefined,
      body,
    );
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
 * DirectionArrow — the flat chevron floating over the local car, aimed down the route.
 *
 * With the gates themselves invisible, this is what tells a player where to go. Its heading is
 * the weighted sum of the unit directions to the next few gates, so it reads as "the way the
 * track goes" rather than "that post right there" and stops flicking as gates are passed. The
 * shape is a flat unlit chevron lying in the ground plane — no shading, no depth to it. It is
 * white rather than the track accent: the accent is a sand tone on a sand-coloured desert map,
 * so it disappeared into the road exactly where it was needed.
 */
function DirectionArrow({
  bodyRef,
  targets,
}: {
  bodyRef: RefObject<RapierRigidBody | null>;
  /** The next few gate positions, nearest first. */
  targets: Vec3[];
}) {
  const group = useRef<THREE.Group>(null);

  const shape = useMemo(() => {
    // Drawn in the XY plane with the tip at -Y; the mesh is laid flat so -Y becomes +Z.
    const s = new THREE.Shape();
    s.moveTo(0, -1.05);
    s.lineTo(0.85, 0.55);
    s.lineTo(0, 0.15);
    s.lineTo(-0.85, 0.55);
    s.closePath();
    return s;
  }, []);

  useFrame((state, dt) => {
    const g = group.current;
    const body = bodyRef.current;
    if (!g) return;
    if (!body || targets.length === 0) {
      g.visible = false;
      return;
    }
    g.visible = true;
    const t = body.translation();

    // Blend the unit directions so a distant gate can't dominate by sheer distance.
    let sx = 0;
    let sz = 0;
    let fallbackX = 0;
    let fallbackZ = 0;
    targets.forEach((target, i) => {
      const dx = target[0] - t.x;
      const dz = target[2] - t.z;
      const distance = Math.hypot(dx, dz) || 1;
      if (i === 0) {
        fallbackX = dx / distance;
        fallbackZ = dz / distance;
      }
      if (distance < ARROW_SKIP_RADIUS) return;
      const weight = ARROW_WEIGHTS[i] ?? 0.2;
      sx += (dx / distance) * weight;
      sz += (dz / distance) * weight;
    });
    // Every gate too close, or the blend cancelled itself out — fall back to the next one.
    if (Math.hypot(sx, sz) < 1e-3) {
      sx = fallbackX;
      sz = fallbackZ;
    }

    const bob = Math.sin(state.clock.elapsedTime * 3) * 0.1;
    g.position.set(t.x, t.y + ARROW_HEIGHT + bob, t.z);

    // Turn the short way round, at a rate that settles in a few frames.
    const yaw = Math.atan2(sx, sz);
    const delta = ((yaw - g.rotation.y + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    g.rotation.y += delta * Math.min(1, dt * 10);
  });

  return (
    <group ref={group} visible={false}>
      {/* Backing plate, a hair below and larger, so the chevron keeps its edge on any map. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} scale={1.18}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial color="#120d09" transparent opacity={0.7} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial color="#ffffff" side={THREE.DoubleSide} toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

/**
 * StartGate — the start/finish archway over gate 0.
 *
 * Built like CheckpointMarkers (posts straddling the opening on the pose's local ±X, so the
 * arch spans the road) with a checkered banner across the top. Every other gate is invisible,
 * so this is the one landmark that says "the lap starts here". Purely visual — no collider.
 * Sunk by START_GATE_DROP because gate poses are captured at the car's chassis height, not at
 * the road surface.
 */
function StartGate({ gate }: { gate: Gate }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#f8f5ee";
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#191410";
      ctx.fillRect(0, 0, 32, 32);
      ctx.fillRect(32, 32, 32, 32);
    }
    const map = new THREE.CanvasTexture(canvas);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.magFilter = THREE.NearestFilter;
    // Two rows of checks, and as many columns as it takes to keep them square.
    const rows = CHECKER_ROWS;
    const columns = Math.max(2, Math.round((gate.width * 2) / (BANNER_HEIGHT / rows)));
    map.repeat.set(columns, rows);
    return map;
  }, [gate.width]);

  useEffect(() => () => texture.dispose(), [texture]);

  const span = gate.width * 2 + POST_THICKNESS;
  return (
    <group
      position={[gate.position[0], gate.position[1] - START_GATE_DROP, gate.position[2]]}
      rotation={[0, gate.rotationY, 0]}
    >
      {[gate.width, -gate.width].map((x) => (
        <mesh key={x} position={[x, POST_HEIGHT / 2, 0]} castShadow>
          <boxGeometry args={[POST_THICKNESS, POST_HEIGHT, POST_THICKNESS]} />
          <meshStandardMaterial color="#f8f5ee" />
        </mesh>
      ))}
      <mesh position={[0, POST_HEIGHT + BANNER_HEIGHT / 2, 0]} castShadow>
        <boxGeometry args={[span, BANNER_HEIGHT, POST_THICKNESS]} />
        <meshStandardMaterial map={texture} />
      </mesh>
    </group>
  );
}

/**
 * SpawnMarker — admin-only preview of the authored start: a white gantry over the exact pose
 * every car spawns on, and an arrow along the direction they will face.
 */
function SpawnMarker({ pose, accent }: { pose: AuthoredPose; accent: string }) {
  return (
    <group>
      <group position={pose.position} rotation={[0, pose.rotationY, 0]}>
        {[3.6, -3.6].map((x) => (
          <mesh key={x} position={[x, 0.8, 0]}>
            <boxGeometry args={[0.3, 3.2, 0.3]} />
            <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.35} />
          </mesh>
        ))}
        <mesh position={[0, 2.4, 0]}>
          <boxGeometry args={[7.5, 0.3, 0.3]} />
          <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.35} />
        </mesh>
        {/* Cones point along +Y, so +90° about X aims this one down the car's forward axis. */}
        <mesh position={[0, 0.2, 2.4]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.7, 1.6, 4]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.6} />
        </mesh>
      </group>
    </group>
  );
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

/**
 * Spectator camera: chases whichever racer is being watched, or orbits the whole map when
 * nobody is picked.
 *
 * The chased pose comes from the same snapshot buffer that drives the ghost, so the camera
 * cannot drift away from the car it is supposed to be on, and no extra refs have to be
 * threaded through the scene. Orbiting the map was the only option before, which at this
 * map's scale meant watching ants.
 */
function SpectatorCamera({
  track,
  remoteBuffers,
  watchDeviceId,
}: {
  track: TrackDef;
  remoteBuffers: RefObject<Map<string, Snapshot[]>>;
  watchDeviceId: string | null;
}) {
  const { camera } = useThree();
  const chaseTarget = useMemo(() => new THREE.Vector3(), []);
  const chasePos = useMemo(() => new THREE.Vector3(), []);
  const chaseQuat = useMemo(() => new THREE.Quaternion(), []);
  const chaseForward = useMemo(() => new THREE.Vector3(), []);
  const view = useMemo(() => {
    const xs = track.gates.map((g) => g.position[0]);
    const zs = track.gates.map((g) => g.position[2]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const radius = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    return { cx, cz, radius };
  }, [track]);
  const target = useMemo(() => new THREE.Vector3(view.cx, 0, view.cz), [view]);

  useFrame((state, dt) => {
    const buffer = watchDeviceId ? remoteBuffers.current?.get(watchDeviceId) : undefined;
    const latest = buffer?.[buffer.length - 1];
    if (latest) {
      chasePos.set(latest.p[0], latest.p[1], latest.p[2]);
      chaseQuat.set(latest.q[0], latest.q[1], latest.q[2], latest.q[3]);
      chaseForward.set(0, 0, 1).applyQuaternion(chaseQuat).setY(0);
      if (chaseForward.lengthSq() < 1e-4) chaseForward.set(0, 0, 1);
      chaseForward.normalize();
      chaseTarget
        .copy(chasePos)
        .addScaledVector(chaseForward, -SPECTATOR_CHASE_DIST)
        .setY(chasePos.y + SPECTATOR_CHASE_HEIGHT);
      // Snap when the gap is huge (the watched racer respawned, or we switched target).
      if (camera.position.distanceTo(chaseTarget) > 40) camera.position.copy(chaseTarget);
      camera.position.lerp(chaseTarget, Math.min(1, dt * 4));
      camera.lookAt(chasePos.x, chasePos.y + 0.8, chasePos.z);
      return;
    }
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
