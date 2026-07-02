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
 * Only renders on touch / coarse-pointer devices. Tilt needs a user gesture on iOS
 * (DeviceOrientationEvent.requestPermission), which the scheme toggle provides.
 */

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function TouchControls() {
  const [isTouch] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia?.("(pointer: coarse)").matches ||
        "ontouchstart" in window ||
        navigator.maxTouchPoints > 0),
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
    <div className="touch-controls pointer-events-none absolute inset-0 z-20 select-none">
      {/* Steering (GUI only) */}
      {scheme === "gui" && (
        <div className="touch-steering absolute flex gap-3">
          <HoldButton
            label="Steer left"
            onHold={() => setTouchInput({ steer: 1 })}
            onRelease={() => setTouchInput({ steer: 0 })}
          >
            ‹
          </HoldButton>
          <HoldButton
            label="Steer right"
            onHold={() => setTouchInput({ steer: -1 })}
            onRelease={() => setTouchInput({ steer: 0 })}
          >
            ›
          </HoldButton>
        </div>
      )}

      {/* Pedals */}
      <div className="touch-pedals absolute flex items-end gap-3">
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

      {/* Scheme toggle + reset + recenter */}
      <div className="touch-tools absolute left-1/2 flex -translate-x-1/2 gap-2">
        <PillButton onClick={toggleScheme}>{scheme === "gui" ? "Tilt: off" : "Tilt: on"}</PillButton>
        {scheme === "tilt" && (
          <PillButton onClick={() => (neutralRef.current = null)}>Recenter</PillButton>
        )}
        <button
          type="button"
          aria-label="Reset car"
          onPointerDown={() => setTouchInput({ reset: true })}
          onPointerUp={() => setTouchInput({ reset: false })}
          onPointerCancel={() => setTouchInput({ reset: false })}
          className="pointer-events-auto rounded-full border border-white/15 bg-black/50 px-4 py-2 text-sm text-white backdrop-blur"
        >
          ⟲
        </button>
      </div>
    </div>
  );
}

function PillButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pointer-events-auto rounded-full border border-white/15 bg-black/50 px-4 py-2 text-xs font-medium text-white backdrop-blur"
    >
      {children}
    </button>
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
      className={`touch-hold pointer-events-auto flex h-[5.5rem] w-[5.5rem] touch-none items-center justify-center rounded-full border text-4xl leading-none backdrop-blur transition active:brightness-125 ${
        accent
          ? "border-cyan-300/60 bg-cyan-500/30 text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.4)]"
          : "border-white/20 bg-white/12 text-white/90"
      }`}
    >
      {children}
    </button>
  );
}
