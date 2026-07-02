import * as THREE from "three";

/**
 * doodle.ts — render-time "doodle" stylization.
 *
 * Keeps the hand-drawn look a *rendering* concern instead of trying to bake it through
 * Tripo's geometry reconstruction. Any mesh (the placeholder boxes or a generated GLB)
 * becomes doodly via flat cel-banded shading (MeshToonMaterial + a stepped gradient
 * ramp), so Tripo's realistic PBR shading is thrown away — the texture/colors survive,
 * the realism doesn't.
 */

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

export interface DoodleStyleOptions {
  /** Fully unlit flat colors (MeshBasicMaterial) instead of cel-banded toon. */
  unlit?: boolean;
}

/**
 * Restyle an object tree in place: swap every mesh's material for a flat doodle material
 * (preserving its base color + albedo map). Safe to run once on a cloned GLB scene.
 */
export function applyDoodleStyle(root: THREE.Object3D, opts: DoodleStyleOptions = {}): void {
  const { unlit = false } = opts;
  const grad = getToonGradientMap();

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (child.userData.__doodled) return; // idempotent (safe under re-render/StrictMode)
    child.userData.__doodled = true;
    const prev = child.material;
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

    child.material = unlit
      ? new THREE.MeshBasicMaterial(base)
      : new THREE.MeshToonMaterial({ ...base, gradientMap: grad });
  });
}
