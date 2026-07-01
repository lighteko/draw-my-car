"use client";

import { Suspense, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, useGLTF } from "@react-three/drei";
import { normalizeOrientation } from "@/lib/rig";
import { applyDoodleStyle } from "@/lib/doodle";

/**
 * GarageTurntable — a slowly rotating platform showing the selected car.
 *
 * Client-only (WebGL). Reuses the same look as the driving scene: normalizeOrientation
 * for pose/scale and applyDoodleStyle for the toon + outline treatment. When no car is
 * selected the platform spins empty; the "+" prompt is a DOM overlay drawn by the page.
 */
export function GarageTurntable({ glbUrl }: { glbUrl: string | null }) {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true }}
      camera={{ position: [0, 2.4, 6.2], fov: 40 }}
    >
      <ambientLight intensity={0.7} />
      <hemisphereLight intensity={0.4} groundColor="#2a2a33" />
      <directionalLight
        castShadow
        position={[6, 10, 6]}
        intensity={2.2}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
      />

      <Turntable>
        <Platform />
        {glbUrl && (
          <Suspense fallback={null}>
            <TurntableCar url={glbUrl} />
          </Suspense>
        )}
      </Turntable>

      <ContactShadows position={[0, 0.01, 0]} opacity={0.5} scale={12} blur={2.2} far={6} />
    </Canvas>
  );
}

/** Rotates its children about +Y for the "showroom" spin. */
function Turntable({ children }: { children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.35;
  });
  return <group ref={ref}>{children}</group>;
}

function Platform() {
  return (
    <mesh receiveShadow position={[0, -0.15, 0]}>
      <cylinderGeometry args={[3, 3.2, 0.3, 64]} />
      <meshStandardMaterial color="#1f2430" roughness={0.85} metalness={0.1} />
    </mesh>
  );
}

function TurntableCar({ url }: { url: string }) {
  const gltf = useGLTF(url);
  const object = useMemo(() => {
    const o = gltf.scene.clone(true);
    normalizeOrientation(o);
    applyDoodleStyle(o);
    // Rest the car's bottom on the platform top (y = 0).
    const box = new THREE.Box3().setFromObject(o);
    o.position.y -= box.min.y;
    o.traverse((child) => {
      if (child instanceof THREE.Mesh) child.castShadow = true;
    });
    return o;
  }, [gltf.scene]);

  return <primitive object={object} />;
}
