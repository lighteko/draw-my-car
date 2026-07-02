"use client";

import { useEffect } from "react";
import { getDriveInput, setKeyboardInput, type DriveInput } from "@/lib/driveInput";

/**
 * useDriveControls — binds keyboard input into the shared drive-input store and returns a
 * stable getter for the merged analog input (keyboard + touch + tilt).
 *
 * Self-contained window listeners (rather than drei's KeyboardControls) so it works
 * identically inside the R3F Canvas without React-context bridging across the renderer.
 * Keyboard maps to full-deflection analog values; touch/tilt add their own contributions.
 */

const CODES = new Set([
  "KeyW",
  "ArrowUp",
  "KeyS",
  "ArrowDown",
  "KeyA",
  "ArrowLeft",
  "KeyD",
  "ArrowRight",
  "Space",
  "KeyR",
]);

export function useDriveControls(): () => DriveInput {
  useEffect(() => {
    const pressed = new Set<string>();

    const recompute = () => {
      const fwd = pressed.has("KeyW") || pressed.has("ArrowUp");
      const back = pressed.has("KeyS") || pressed.has("ArrowDown");
      const left = pressed.has("KeyA") || pressed.has("ArrowLeft");
      const right = pressed.has("KeyD") || pressed.has("ArrowRight");
      setKeyboardInput({
        throttle: (fwd ? 1 : 0) + (back ? -1 : 0),
        steer: (left ? 1 : 0) + (right ? -1 : 0),
        brake: pressed.has("Space"),
        reset: pressed.has("KeyR"),
      });
    };

    const onDown = (e: KeyboardEvent) => {
      if (!CODES.has(e.code)) return;
      e.preventDefault(); // stop arrows/space from scrolling the page
      pressed.add(e.code);
      recompute();
    };
    const onUp = (e: KeyboardEvent) => {
      if (!CODES.has(e.code)) return;
      pressed.delete(e.code);
      recompute();
    };

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      setKeyboardInput({ throttle: 0, steer: 0, brake: false, reset: false });
    };
  }, []);

  return getDriveInput;
}
