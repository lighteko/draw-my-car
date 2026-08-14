export interface VehicleTuning {
  carMass: number;
  engineForce: number;
  reverseForce: number;
  brakeForce: number;
  /** Steering lock (rad) available at low speed. */
  maxSteer: number;
  /** Steering lock (rad) remaining at/above the high-speed fade end. */
  highSpeedSteer: number;
  frictionSlip: number;
  sideFriction: number;
  /** Rear-wheel side friction while the handbrake is held (drifting). */
  handbrakeSideFriction: number;
  /** Terminal speed (m/s) the drag model converges to at full throttle. */
  topSpeed: number;
}

// Forces are tuned against carMass — scale them together or the car turns into a
// slug (or a rocket). The suspension constants in VehicleRig are mass-normalized
// by Rapier's vehicle controller, so they don't need to track mass.
export const DEFAULT_VEHICLE_TUNING: VehicleTuning = {
  carMass: 1200,
  engineForce: 6400,
  reverseForce: 3600,
  brakeForce: 64,
  maxSteer: 0.55,
  highSpeedSteer: 0.18,
  frictionSlip: 6.25,
  sideFriction: 1.4,
  handbrakeSideFriction: 0.55,
  topSpeed: 28,
};

/**
 * Merge a (possibly partial / older) stored tuning with current defaults, so maps
 * saved before a field existed keep working.
 */
export function resolveVehicleTuning(stored?: Partial<VehicleTuning> | null): VehicleTuning {
  return { ...DEFAULT_VEHICLE_TUNING, ...(stored ?? {}) };
}
