/**
 * graphicsSettings.ts — admin-tunable scene lighting/environment.
 *
 * Mirrors vehicleTuning: a plain settings object the admin panel edits live and the
 * RaceScene applies to its lights and fog. Sun direction is stored as azimuth/elevation
 * (degrees) so a single direction pad can drive it; sunPosition() turns that into the
 * directional light's world position.
 */

export interface GraphicsSettings {
  /** Compass angle of the sun on the ground plane (deg, 0 = +Z, clockwise). */
  sunAzimuth: number;
  /** Height of the sun above the horizon (deg, 90 = straight overhead). */
  sunElevation: number;
  /** Directional (sun) light intensity. */
  sunIntensity: number;
  /** Flat ambient fill. */
  ambient: number;
  /** Hemisphere (sky/ground) fill. */
  fill: number;
  /** Whether the sun casts shadows. */
  shadows: boolean;
  /** Whether distance fog is drawn. */
  fog: boolean;
  /** Fog starts fading in at this distance. */
  fogNear: number;
  /** Everything past this distance is fully fogged. */
  fogFar: number;
  /** Shadow map resolution (px per side). Higher = crisper, less blocky shadow edges. */
  shadowMapSize: number;
  /** Depth bias that pushes shadows off surfaces to kill self-shadow "acne" striping. */
  shadowBias: number;
  /** Bias along the surface normal — softens acne on steep faces without detaching shadows. */
  shadowNormalBias: number;
}

// Defaults reproduce the scene's original hardcoded lighting: sun at [40, 70, 20]
// (≈63° azimuth, ≈57° elevation) and fog 140→550.
export const DEFAULT_GRAPHICS_SETTINGS: GraphicsSettings = {
  sunAzimuth: 63,
  sunElevation: 57,
  sunIntensity: 2,
  ambient: 0.7,
  fill: 0.4,
  shadows: true,
  fog: true,
  fogNear: 140,
  fogFar: 550,
  shadowMapSize: 2048,
  shadowBias: -0.0002,
  shadowNormalBias: 0.02,
};

/** Distance from the origin the sun is placed at (large enough to cover the shadow camera). */
const SUN_DISTANCE = 120;

/** World position for the directional light from its azimuth/elevation. */
export function sunPosition(settings: GraphicsSettings): [number, number, number] {
  const az = (settings.sunAzimuth * Math.PI) / 180;
  const el = (settings.sunElevation * Math.PI) / 180;
  const horiz = Math.cos(el);
  return [
    SUN_DISTANCE * horiz * Math.sin(az),
    SUN_DISTANCE * Math.sin(el),
    SUN_DISTANCE * horiz * Math.cos(az),
  ];
}

/** Merge a (possibly partial / older) stored settings with current defaults. */
export function resolveGraphicsSettings(
  stored?: Partial<GraphicsSettings> | null,
): GraphicsSettings {
  return { ...DEFAULT_GRAPHICS_SETTINGS, ...(stored ?? {}) };
}
