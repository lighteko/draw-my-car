"use client";

import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { normalizeOrientation } from "@/lib/rig";
import { applyDoodleStyle } from "@/lib/doodle";
import type { Quat, Vec3n } from "@/lib/roomTypes";

/**
 * RemoteVehicle — another player's car, driven by the network, not physics.
 *
 * Incoming poses are buffered (tagged with local receive time) and rendered ~100 ms in
 * the past, interpolating between the two surrounding snapshots. Using local receive time
 * (not the sender's clock) sidesteps cross-client clock skew.
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
  const groupRef = useRef<THREE.Group>(null);

  // Sit at the grid slot until the first pose arrives.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.position.set(spawn.position[0], 1.2, spawn.position[2]);
    g.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawn.rotationY);
  }, [spawn]);

  const qa = useMemo(() => new THREE.Quaternion(), []);
  const qb = useMemo(() => new THREE.Quaternion(), []);

  useFrame(() => {
    const g = groupRef.current;
    const buf = getBuffer();
    if (!g || !buf || buf.length === 0) return;

    const renderTime = performance.now() - INTERP_DELAY;

    // Latest snapshot at or before renderTime.
    let i = buf.length - 1;
    while (i > 0 && buf[i].t > renderTime) i--;
    const a = buf[i];
    const b = buf[i + 1];

    if (!b) {
      g.position.set(a.p[0], a.p[1], a.p[2]);
      g.quaternion.set(a.q[0], a.q[1], a.q[2], a.q[3]);
      return;
    }

    const span = b.t - a.t || 1;
    const alpha = THREE.MathUtils.clamp((renderTime - a.t) / span, 0, 1);
    g.position.set(
      THREE.MathUtils.lerp(a.p[0], b.p[0], alpha),
      THREE.MathUtils.lerp(a.p[1], b.p[1], alpha),
      THREE.MathUtils.lerp(a.p[2], b.p[2], alpha),
    );
    qa.set(a.q[0], a.q[1], a.q[2], a.q[3]);
    qb.set(b.q[0], b.q[1], b.q[2], b.q[3]);
    g.quaternion.slerpQuaternions(qa, qb, alpha);
  });

  return (
    <group ref={groupRef}>
      {glbUrl ? (
        <Suspense fallback={null}>
          <RemoteModel url={glbUrl} />
        </Suspense>
      ) : (
        <GhostCar />
      )}
    </group>
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
