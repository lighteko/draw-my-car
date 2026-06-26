import * as THREE from "three";

/**
 * doodle.ts — render-time "doodle" stylization.
 *
 * Keeps the hand-drawn look a *rendering* concern instead of trying to bake it through
 * Tripo's geometry reconstruction. Any mesh (the placeholder boxes or a generated GLB)
 * becomes doodly via two cheap tricks:
 *   1. flat cel-banded shading (MeshToonMaterial + a stepped gradient ramp), so Tripo's
 *      realistic PBR shading is thrown away — the texture/colors survive, the realism doesn't.
 *   2. a dark inverted-hull outline (a slightly inflated back-face shell behind each mesh).
 */

export const OUTLINE_COLOR = "#16130f";
/** Outline thickness in world units (per-mesh; small so it reads as a pen stroke). */
export const OUTLINE_THICKNESS = 0.03;

let gradientMap: THREE.DataTexture | null = null;

/** A few-step grayscale ramp that turns MeshToonMaterial into flat cel bands. */
export function getToonGradientMap(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const steps = new Uint8Array([90, 160, 225, 255]); // 4 flat bands
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradientMap = tex;
  return tex;
}

/**
 * Per-axis scale that grows a centered box/cylinder by ~`thickness` world units on
 * every side — a uniform-thickness outline shell for the placeholder primitives.
 */
export function outlineScaleFor(
  dims: [number, number, number],
  thickness: number = OUTLINE_THICKNESS,
): [number, number, number] {
  return [
    1 + (2 * thickness) / dims[0],
    1 + (2 * thickness) / dims[1],
    1 + (2 * thickness) / dims[2],
  ];
}

export interface DoodleStyleOptions {
  /** Add the inverted-hull outline (default true). */
  outline?: boolean;
  outlineColor?: THREE.ColorRepresentation;
  outlineThickness?: number;
  /** Fully unlit flat colors (MeshBasicMaterial) instead of cel-banded toon. */
  unlit?: boolean;
}

/** Build an inflated copy of a geometry, pushed out along its vertex normals. */
function inflateGeometry(source: THREE.BufferGeometry, thickness: number): THREE.BufferGeometry {
  const geometry = source.clone();
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    position.setXYZ(
      i,
      position.getX(i) + normal.getX(i) * thickness,
      position.getY(i) + normal.getY(i) * thickness,
      position.getZ(i) + normal.getZ(i) * thickness,
    );
  }
  position.needsUpdate = true;
  return geometry;
}

/**
 * Restyle an object tree in place: swap every mesh's material for a flat doodle material
 * (preserving its base color + albedo map) and attach an inverted-hull outline.
 * Safe to run once on a cloned GLB scene.
 */
export function applyDoodleStyle(root: THREE.Object3D, opts: DoodleStyleOptions = {}): void {
  const {
    outline = true,
    outlineColor = OUTLINE_COLOR,
    outlineThickness = OUTLINE_THICKNESS,
    unlit = false,
  } = opts;
  const grad = getToonGradientMap();

  // Collect first so we don't traverse into the outline children we add below.
  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (child instanceof THREE.Mesh && !child.userData.__doodleOutline) meshes.push(child);
  });

  for (const mesh of meshes) {
    if (mesh.userData.__doodled) continue; // idempotent (safe under re-render/StrictMode)
    mesh.userData.__doodled = true;
    const prev = mesh.material;
    const source = (Array.isArray(prev) ? prev[0] : prev) as
      | (THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null })
      | undefined;

    // Carry over base color + albedo texture so Tripo's painted texture survives.
    const base: THREE.MeshBasicMaterialParameters = {};
    if (source) {
      if (source.color) base.color = source.color;
      if (source.map) base.map = source.map;
      base.transparent = source.transparent;
      base.opacity = source.opacity;
      base.vertexColors = source.vertexColors;
    }

    mesh.material = unlit
      ? new THREE.MeshBasicMaterial(base)
      : new THREE.MeshToonMaterial({ ...base, gradientMap: grad });

    if (outline) {
      const outlineMesh = new THREE.Mesh(
        inflateGeometry(mesh.geometry, outlineThickness),
        new THREE.MeshBasicMaterial({ color: outlineColor, side: THREE.BackSide }),
      );
      outlineMesh.userData.__doodleOutline = true;
      outlineMesh.castShadow = false;
      outlineMesh.receiveShadow = false;
      mesh.add(outlineMesh);
    }
  }
}
