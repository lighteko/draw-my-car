"use client";

import { Suspense, useMemo } from "react";
import * as THREE from "three";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, OrbitControls, useGLTF } from "@react-three/drei";
import { normalizeOrientation } from "@/lib/rig";
import { applyDoodleStyle } from "@/lib/doodle";

/**
 * GarageTurntable — a showroom platform showing the selected car.
 *
 * Client-only (WebGL). The camera auto-orbits and the player can drag to spin it manually
 * (azimuth only; zoom/pan locked), resuming auto-rotate after. Reuses the driving-scene
 * look: normalizeOrientation for pose/scale and applyDoodleStyle for the toon + outline.
 */
export function GarageTurntable({ glbUrl }: { glbUrl: string | null }) {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true }}
      camera={{ position: [0, 2.4, 6.2], fov: 40 }}
    >
      <ambientLight intensity={0.55} />
      <hemisphereLight intensity={0.35} groundColor="#1a1a22" />
      <directionalLight
        castShadow
        position={[6, 10, 6]}
        intensity={2.4}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
      />
      {/* Cool rim light from behind for the showroom look. */}
      <pointLight position={[-4, 3.5, -5]} intensity={40} color="#22d3ee" distance={22} decay={2} />
      <pointLight position={[5, 2, -4]} intensity={22} color="#f59e0b" distance={18} decay={2} />

      <group>
        <Platform />
        {glbUrl && (
          <Suspense fallback={null}>
            <TurntableCar url={glbUrl} />
          </Suspense>
        )}
      </group>

      <ContactShadows position={[0, 0.01, 0]} opacity={0.5} scale={12} blur={2.2} far={6} />

      <OrbitControls
        makeDefault
        enablePan={false}
        enableZoom={false}
        enableDamping
        dampingFactor={0.12}
        autoRotate
        autoRotateSpeed={0.9}
        target={[0, 0.6, 0]}
        minPolarAngle={Math.PI / 2.55}
        maxPolarAngle={Math.PI / 2.05}
      />
    </Canvas>
  );
}

function Platform() {
  return (
    <group>
      <mesh receiveShadow position={[0, -0.15, 0]}>
        <cylinderGeometry args={[3, 3.25, 0.3, 72]} />
        <meshStandardMaterial color="#141821" roughness={0.7} metalness={0.25} />
      </mesh>
      {/* Glowing accent rim (unlit so it reads as a light line). */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <torusGeometry args={[3, 0.035, 8, 90]} />
        <meshBasicMaterial color="#22d3ee" toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
        <ringGeometry args={[2.4, 2.95, 72]} />
        <meshBasicMaterial color="#0e7490" transparent opacity={0.25} toneMapped={false} />
      </mesh>
    </group>
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
