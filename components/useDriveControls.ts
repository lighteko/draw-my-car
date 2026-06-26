"use client";

import { useEffect, useRef } from "react";
import type { ControlName } from "./VehicleRig";

/**
 * useDriveControls — minimal keyboard input for driving.
 *
 * Uses window key listeners and stores pressed state in a ref, exposing a stable
 * getter. This is deliberately self-contained (rather than drei's KeyboardControls)
 * so it works identically inside the R3F Canvas without relying on React-context
 * bridging across the renderer boundary.
 */
export type DriveControls = Record<ControlName, boolean>;

const KEY_MAP: Record<string, ControlName> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  Space: "brake",
  KeyR: "reset",
};

export function useDriveControls(): () => DriveControls {
  const state = useRef<DriveControls>({
    forward: false,
    back: false,
    left: false,
    right: false,
    brake: false,
    reset: false,
  });

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const name = KEY_MAP[e.code];
      if (!name) return;
      e.preventDefault(); // stop arrows/space from scrolling the page
      state.current[name] = true;
    };
    const onUp = (e: KeyboardEvent) => {
      const name = KEY_MAP[e.code];
      if (!name) return;
      state.current[name] = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  return () => state.current;
}
