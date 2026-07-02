"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { resetTouchInput, setTiltEnabled, setTiltSteer, setTouchInput } from "@/lib/driveInput";

/**
 * TouchControls — on-screen driving controls for phones (writes into the shared
 * driveInput store). Two schemes:
 *   • GUI  — left/right steer buttons + gas/reverse pedals
 *   • Tilt — device roll steers; gas/reverse pedals for throttle
 *
 * Only renders on touch devices. Tilt needs a user gesture on iOS
 * (DeviceOrientationEvent.requestPermission), which the scheme toggle provides.
 */

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function TouchControls() {
  const [isTouch] = useState(
    () =>
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0),
  );
  const [scheme, setScheme] = useState<"gui" | "tilt">("gui");
  const neutralRef = useRef<number | null>(null);

  const onOrientation = useCallback((e: DeviceOrientationEvent) => {
    // In landscape the roll axis is beta; in portrait it's gamma.
    const landscape = window.innerWidth >= window.innerHeight;
    const raw = (landscape ? e.beta : e.gamma) ?? 0;
    if (neutralRef.current === null) neutralRef.current = raw;
    let delta = raw - neutralRef.current;
    if (Math.abs(delta) < 3) delta = 0; // deadzone
    // Roll right → steer right (steer is +left). Flip the sign here if it feels inverted.
    setTiltSteer(clamp(-delta / 30, -1, 1));
  }, []);

  const enableTilt = useCallback(async () => {
    const DOE = window.DeviceOrientationEvent as
      | (typeof window.DeviceOrientationEvent & {
          requestPermission?: () => Promise<"granted" | "denied">;
        })
      | undefined;
    if (DOE && typeof DOE.requestPermission === "function") {
      try {
        if ((await DOE.requestPermission()) !== "granted") return false;
      } catch {
        return false;
      }
    }
    neutralRef.current = null;
    window.addEventListener("deviceorientation", onOrientation);
    setTiltEnabled(true);
    return true;
  }, [onOrientation]);

  const disableTilt = useCallback(() => {
    window.removeEventListener("deviceorientation", onOrientation);
    setTiltEnabled(false);
  }, [onOrientation]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
      setTiltEnabled(false);
      resetTouchInput();
    };
  }, [onOrientation]);

  const toggleScheme = useCallback(async () => {
    if (scheme === "gui") {
      if (await enableTilt()) setScheme("tilt");
    } else {
      disableTilt();
      setScheme("gui");
    }
  }, [scheme, enableTilt, disableTilt]);

  if (!isTouch) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 select-none">
      {/* Steering (GUI only) */}
      {scheme === "gui" && (
        <div className="absolute bottom-6 left-6 flex gap-3">
          <HoldButton
            label="Steer left"
            onHold={() => setTouchInput({ steer: 1 })}
            onRelease={() => setTouchInput({ steer: 0 })}
          >
            ◄
          </HoldButton>
          <HoldButton
            label="Steer right"
            onHold={() => setTouchInput({ steer: -1 })}
            onRelease={() => setTouchInput({ steer: 0 })}
          >
            ►
          </HoldButton>
        </div>
      )}

      {/* Pedals */}
      <div className="absolute bottom-6 right-6 flex items-end gap-3">
        <HoldButton
          label="Reverse"
          onHold={() => setTouchInput({ throttle: -1 })}
          onRelease={() => setTouchInput({ throttle: 0 })}
        >
          ▼
        </HoldButton>
        <HoldButton
          label="Accelerate"
          accent
          onHold={() => setTouchInput({ throttle: 1 })}
          onRelease={() => setTouchInput({ throttle: 0 })}
        >
          ▲
        </HoldButton>
      </div>

      {/* Scheme toggle + reset */}
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 gap-2">
        <button
          type="button"
          onClick={toggleScheme}
          className="pointer-events-auto rounded-full bg-black/45 px-4 py-2 text-xs font-medium text-white backdrop-blur"
        >
          {scheme === "gui" ? "Tilt: off" : "Tilt: on"}
        </button>
        {scheme === "tilt" && (
          <button
            type="button"
            onClick={() => (neutralRef.current = null)}
            className="pointer-events-auto rounded-full bg-black/45 px-4 py-2 text-xs font-medium text-white backdrop-blur"
          >
            Recenter
          </button>
        )}
        <button
          type="button"
          onPointerDown={() => setTouchInput({ reset: true })}
          onPointerUp={() => setTouchInput({ reset: false })}
          onPointerCancel={() => setTouchInput({ reset: false })}
          className="pointer-events-auto rounded-full bg-black/45 px-4 py-2 text-xs font-medium text-white backdrop-blur"
        >
          ⟲
        </button>
      </div>
    </div>
  );
}

function HoldButton({
  onHold,
  onRelease,
  label,
  accent = false,
  children,
}: {
  onHold: () => void;
  onRelease: () => void;
  label: string;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        onHold();
      }}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      className={`pointer-events-auto flex h-20 w-20 touch-none items-center justify-center rounded-full text-3xl text-white backdrop-blur active:brightness-125 ${
        accent ? "bg-emerald-600/70" : "bg-white/20"
      }`}
    >
      {children}
    </button>
  );
}
