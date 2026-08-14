"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrthographicCamera, useGLTF } from "@react-three/drei";
import type { RapierRigidBody } from "@react-three/rapier";
import type { AuthoredPose, TrackDef } from "@/lib/tracks";

/**
 * AdminMinimap — a top-down orthographic view of the current map, for admin test drives.
 *
 * A small dedicated R3F canvas renders the map (uploaded GLB or the gate ground) straight
 * down through an orthographic camera framed to the map bounds; a DOM overlay draws the live
 * car dot and the last teleport marker. Clicking anywhere on the square converts the pixel to
 * world XZ (the projection is kept identical to the camera frustum) and calls `onTeleport`,
 * which the scene consumes to move the car and revise its respawn point.
 */

const SIZE = 176;

interface Bounds {
  cx: number;
  cz: number;
  half: number;
}

export function AdminMinimap({
  track,
  spawn,
  selfBody,
  onTeleport,
}: {
  track: TrackDef;
  /** The staged start pose, drawn so the admin can see where the grid sits. */
  spawn?: AuthoredPose | null;
  selfBody: RefObject<RapierRigidBody | null>;
  /** World XZ the admin clicked. The scene teleports the car there and moves the respawn. */
  onTeleport: (x: number, z: number) => void;
}) {
  // Bounds from the track's known geometry — used until (and if) a GLB model reports tighter
  // bounds from its actual bounding box.
  const fallbackBounds = useMemo<Bounds>(() => {
    const pts: number[][] = [
      ...track.gates.map((g) => g.position),
      ...track.decorations.map((d) => d.position),
      ...track.spawns.map((s) => s.position),
    ];
    if (pts.length === 0) return { cx: 0, cz: 0, half: 60 };
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[2]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    return {
      cx: (minX + maxX) / 2,
      cz: (minZ + maxZ) / 2,
      half: (Math.max(maxX - minX, maxZ - minZ, 40) / 2) * 1.15,
    };
  }, [track]);

  const [modelBounds, setModelBounds] = useState<Bounds | null>(null);
  const bounds = modelBounds ?? fallbackBounds;

  // World XZ → minimap pixel. Matches the ortho camera set in MinimapCamera: +X is right,
  // +Z is down (camera up = -Z), so this stays in lockstep with the click math below.
  const project = (x: number, z: number) => ({
    x: ((x - bounds.cx) / (2 * bounds.half) + 0.5) * SIZE,
    y: ((z - bounds.cz) / (2 * bounds.half) + 0.5) * SIZE,
  });

  const gatePath = useMemo(
    () =>
      track.gates
        .map((g) => {
          const p = project(g.position[0], g.position[2]);
          return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        })
        .join(" "),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track, bounds],
  );

  const [carDot, setCarDot] = useState<{ x: number; y: number } | null>(null);
  const [marker, setMarker] = useState<{ x: number; z: number } | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      const body = selfBody.current;
      if (!body) return;
      const t = body.translation();
      setCarDot(project(t.x, t.z));
    }, 80);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfBody, bounds]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    const worldX = bounds.cx + (u - 0.5) * bounds.half * 2;
    const worldZ = bounds.cz + (v - 0.5) * bounds.half * 2;
    setMarker({ x: worldX, z: worldZ });
    onTeleport(worldX, worldZ);
  };

  const markerPx = marker ? project(marker.x, marker.z) : null;
  const spawnPx = spawn ? project(spawn.position[0], spawn.position[2]) : null;
  const gate0 = track.gates[0];
  const startPx = gate0 ? project(gate0.position[0], gate0.position[2]) : null;
  // Screen angle of the start heading: +X is right and +Z is down, so heading → (sin, cos).
  // The quarter turn lays the marker across the track, matching the 3D mat.
  const startAngle = gate0
    ? (Math.atan2(Math.cos(gate0.rotationY), Math.sin(gate0.rotationY)) * 180) / Math.PI + 90
    : 0;

  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-20 flex -translate-x-1/2 flex-col items-center">
      <div className="game-panel rounded-xl p-1.5">
        <div
          onClick={handleClick}
          className="pointer-events-auto relative cursor-crosshair overflow-hidden rounded-lg bg-black/50"
          style={{ width: SIZE, height: SIZE }}
        >
          <Canvas
            dpr={1}
            frameloop="demand"
            gl={{ alpha: true, antialias: true }}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            {/* Straight-down orthographic view framed to [cx±half, cz±half]. rotationX=-90°
                keeps +X to the right and +Z downward, matching project()/handleClick. */}
            <OrthographicCamera
              makeDefault
              position={[bounds.cx, 300, bounds.cz]}
              rotation={[-Math.PI / 2, 0, 0]}
              left={-bounds.half}
              right={bounds.half}
              top={bounds.half}
              bottom={-bounds.half}
              near={1}
              far={2000}
            />
            <Invalidator trigger={bounds} />
            <ambientLight intensity={0.9} />
            <hemisphereLight intensity={0.5} groundColor="#222" />
            <directionalLight position={[bounds.cx + 40, 200, bounds.cz + 20]} intensity={1.2} />
            {track.modelUrl ? (
              <Suspense fallback={null}>
                <MinimapModel
                  url={track.modelUrl}
                  scale={track.modelScale ?? 1}
                  onBounds={setModelBounds}
                />
              </Suspense>
            ) : (
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[bounds.cx, 0, bounds.cz]}>
                <planeGeometry args={[bounds.half * 2, bounds.half * 2]} />
                <meshBasicMaterial color={track.groundColor} />
              </mesh>
            )}
          </Canvas>

          <svg
            width={SIZE}
            height={SIZE}
            className="pointer-events-none absolute inset-0"
            aria-hidden
          >
            <defs>
              <pattern id="amm-checker" width={7} height={7} patternUnits="userSpaceOnUse">
                <rect width={7} height={7} fill="#f8f5ee" />
                <rect width={3.5} height={3.5} fill="#191410" />
                <rect x={3.5} y={3.5} width={3.5} height={3.5} fill="#191410" />
              </pattern>
            </defs>
            {track.gates.length > 0 && (
              <polygon
                points={gatePath}
                fill="none"
                stroke="rgba(255,255,255,0.35)"
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            )}
            {startPx && (
              <rect
                x={startPx.x - 7}
                y={startPx.y - 4.5}
                width={14}
                height={9}
                fill="url(#amm-checker)"
                stroke="rgba(0,0,0,0.55)"
                strokeWidth={1}
                transform={`rotate(${startAngle.toFixed(1)} ${startPx.x.toFixed(1)} ${startPx.y.toFixed(1)})`}
              />
            )}
            {markerPx && (
              <g>
                <circle
                  cx={markerPx.x}
                  cy={markerPx.y}
                  r={7}
                  fill="none"
                  stroke="#e0a84e"
                  strokeWidth={1.5}
                />
                <circle cx={markerPx.x} cy={markerPx.y} r={1.5} fill="#e0a84e" />
              </g>
            )}
            {spawnPx && spawn && (
              // Arrowhead pointing the way cars will face. World +X is right and +Z is down
              // on this projection, so the heading maps to (sin, cos) straight through.
              <polygon
                points={spawnArrow(spawnPx.x, spawnPx.y, spawn.rotationY)}
                fill="#ffffff"
                stroke="rgba(0,0,0,0.6)"
                strokeWidth={1}
                strokeLinejoin="round"
              />
            )}
            {carDot && (
              <circle
                cx={carDot.x}
                cy={carDot.y}
                r={4}
                fill="#34d399"
                stroke="rgba(0,0,0,0.6)"
                strokeWidth={1}
              />
            )}
          </svg>
        </div>
        <div className="px-1 pt-1 text-center font-mono text-[9px] uppercase tracking-wider text-amber-200/70">
          맵을 클릭하면 이동합니다
        </div>
      </div>
    </div>
  );
}

/** Triangle points for the start marker at pixel (x, y) facing world yaw. */
function spawnArrow(x: number, y: number, yaw: number): string {
  const dx = Math.sin(yaw);
  const dy = Math.cos(yaw);
  const px = -dy;
  const py = dx;
  return [
    `${(x + dx * 8).toFixed(1)},${(y + dy * 8).toFixed(1)}`,
    `${(x - dx * 4 + px * 5).toFixed(1)},${(y - dy * 4 + py * 5).toFixed(1)}`,
    `${(x - dx * 4 - px * 5).toFixed(1)},${(y - dy * 4 - py * 5).toFixed(1)}`,
  ].join(" ");
}

/** Kicks a render whenever bounds change (the demand loop is otherwise idle). */
function Invalidator({ trigger }: { trigger: unknown }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    invalidate();
  }, [invalidate, trigger]);
  return null;
}

function MinimapModel({
  url,
  scale,
  onBounds,
}: {
  url: string;
  scale: number;
  onBounds: (bounds: Bounds) => void;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const gltf = useGLTF(url);
  const scene = useMemo(() => {
    const clone = gltf.scene.clone(true);
    clone.scale.setScalar(scale);
    clone.updateMatrixWorld(true);
    return clone;
  }, [gltf.scene, scale]);

  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene);
    if (!Number.isFinite(box.min.x) || box.isEmpty()) return;
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const half = (Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 20) / 2) * 1.05;
    onBounds({ cx, cz, half });
    invalidate();
  }, [scene, onBounds, invalidate]);

  return <primitive object={scene} />;
}
