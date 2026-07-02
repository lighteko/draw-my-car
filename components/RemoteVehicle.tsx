"use client";

import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { useGLTF } from "@react-three/drei";
import {
  CuboidCollider,
  RigidBody,
  useBeforePhysicsStep,
  type RapierRigidBody,
} from "@react-three/rapier";
import { normalizeOrientation } from "@/lib/rig";
import { applyDoodleStyle } from "@/lib/doodle";
import type { Quat, Vec3n } from "@/lib/roomTypes";

/**
 * RemoteVehicle — another player's car, driven by the network, not by physics.
 *
 * Incoming poses are buffered (tagged with local receive time) and applied ~100 ms in the
 * past, interpolating between the two surrounding snapshots (local time sidesteps clock
 * skew). The car is a kinematic-position body so the local dynamic car feels bumps against
 * it (one-directional — the ghost is unaffected, so there's no authority conflict).
 */

export interface Snapshot {
  t: number; // local receive time (performance.now)
  p: Vec3n;
  q: Quat;
}

const INTERP_DELAY = 100; // ms
const BUFFER_MS = 1000;

/** Push a snapshot into a per-device buffer, trimming stale entries. Used by the page. */
export function pushSnapshot(buffer: Snapshot[], p: Vec3n, q: Quat): void {
  const now = performance.now();
  buffer.push({ t: now, p, q });
  const cutoff = now - BUFFER_MS;
  while (buffer.length > 2 && buffer[0].t < cutoff) buffer.shift();
}

export function RemoteVehicle({
  glbUrl,
  spawn,
  getBuffer,
}: {
  glbUrl: string | null;
  spawn: { position: Vec3n; rotationY: number };
  getBuffer: () => Snapshot[] | undefined;
}) {
  const bodyRef = useRef<RapierRigidBody>(null);
  const qa = useMemo(() => new THREE.Quaternion(), []);
  const qb = useMemo(() => new THREE.Quaternion(), []);
  const out = useMemo(() => new THREE.Quaternion(), []);

  useBeforePhysicsStep(() => {
    const body = bodyRef.current;
    if (!body) return;
    const buf = getBuffer();

    if (!buf || buf.length === 0) return; // stay at the grid until poses arrive

    const renderTime = performance.now() - INTERP_DELAY;
    let i = buf.length - 1;
    while (i > 0 && buf[i].t > renderTime) i--;
    const a = buf[i];
    const b = buf[i + 1];

    if (!b) {
      body.setNextKinematicTranslation({ x: a.p[0], y: a.p[1], z: a.p[2] });
      body.setNextKinematicRotation({ x: a.q[0], y: a.q[1], z: a.q[2], w: a.q[3] });
      return;
    }

    const span = b.t - a.t || 1;
    const alpha = THREE.MathUtils.clamp((renderTime - a.t) / span, 0, 1);
    body.setNextKinematicTranslation({
      x: THREE.MathUtils.lerp(a.p[0], b.p[0], alpha),
      y: THREE.MathUtils.lerp(a.p[1], b.p[1], alpha),
      z: THREE.MathUtils.lerp(a.p[2], b.p[2], alpha),
    });
    qa.set(a.q[0], a.q[1], a.q[2], a.q[3]);
    qb.set(b.q[0], b.q[1], b.q[2], b.q[3]);
    out.slerpQuaternions(qa, qb, alpha);
    body.setNextKinematicRotation({ x: out.x, y: out.y, z: out.z, w: out.w });
  });

  return (
    <RigidBody
      ref={bodyRef}
      type="kinematicPosition"
      colliders={false}
      position={[spawn.position[0], 1.2, spawn.position[2]]}
      rotation={[0, spawn.rotationY, 0]}
    >
      <CuboidCollider args={[0.9, 0.5, 1.9]} />
      {glbUrl ? (
        <Suspense fallback={null}>
          <RemoteModel url={glbUrl} />
        </Suspense>
      ) : (
        <GhostCar />
      )}
    </RigidBody>
  );
}

function RemoteModel({ url }: { url: string }) {
  const gltf = useGLTF(url);
  const object = useMemo(() => {
    const o = gltf.scene.clone(true);
    normalizeOrientation(o);
    applyDoodleStyle(o);
    o.traverse((child) => {
      if (child instanceof THREE.Mesh) child.castShadow = true;
    });
    return o;
  }, [gltf.scene]);
  return <primitive object={object} />;
}

/** Fallback body for a remote player who has no generated car. */
function GhostCar() {
  return (
    <mesh castShadow position={[0, 0.5, 0]}>
      <boxGeometry args={[1.6, 0.8, 3.6]} />
      <meshToonMaterial color="#94a3b8" transparent opacity={0.85} />
    </mesh>
  );
}
