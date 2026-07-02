"use client";

/**
 * driveInput.ts — a single shared, analog driving-input store.
 *
 * Multiple sources (keyboard, on-screen touch, device tilt) each write their own
 * contribution; getDriveInput() merges them. Keeping this a module singleton (rather than
 * React state) lets the physics step read it every frame with zero re-renders, and lets any
 * overlay (TouchControls) drive the car without prop-drilling into the R3F tree.
 *
 * Conventions match VehicleRig: steer +1 = full left, throttle +1 = full forward.
 */

export interface DriveInput {
  /** -1 (reverse) .. 1 (forward). */
  throttle: number;
  /** -1 (right) .. 1 (left). */
  steer: number;
  brake: boolean;
  reset: boolean;
}

interface Source {
  throttle: number;
  steer: number;
  brake: boolean;
  reset: boolean;
}

const keyboard: Source = { throttle: 0, steer: 0, brake: false, reset: false };
const touch: Source = { throttle: 0, steer: 0, brake: false, reset: false };
const tilt = { steer: 0, enabled: false };

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function getDriveInput(): DriveInput {
  return {
    throttle: clamp(keyboard.throttle + touch.throttle, -1, 1),
    steer: clamp(keyboard.steer + touch.steer + (tilt.enabled ? tilt.steer : 0), -1, 1),
    brake: keyboard.brake || touch.brake,
    reset: keyboard.reset || touch.reset,
  };
}

export function setKeyboardInput(patch: Partial<Source>): void {
  Object.assign(keyboard, patch);
}

export function setTouchInput(patch: Partial<Source>): void {
  Object.assign(touch, patch);
}

export function resetTouchInput(): void {
  touch.throttle = 0;
  touch.steer = 0;
  touch.brake = false;
  touch.reset = false;
}

export function setTiltSteer(steer: number): void {
  tilt.steer = clamp(steer, -1, 1);
}

export function setTiltEnabled(enabled: boolean): void {
  tilt.enabled = enabled;
  if (!enabled) tilt.steer = 0;
}
