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
 *
 * Each button tracks its own held state and the merged input is recomputed on every
 * change (like the keyboard's pressed-set) — a plain last-writer-wins store would
 * zero the throttle when a second, overlapping finger lifts.
 */

interface HeldButtons {
  left: boolean;
  right: boolean;
  gas: boolean;
  reverse: boolean;
  brake: boolean;
}

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
  const heldRef = useRef<HeldButtons>({
    left: false,
    right: false,
    gas: false,
    reverse: false,
    brake: false,
  });

  const setHeld = useCallback((key: keyof HeldButtons, down: boolean) => {
    const h = heldRef.current;
    h[key] = down;
    setTouchInput({
      steer: (h.left ? 1 : 0) + (h.right ? -1 : 0),
      throttle: (h.gas ? 1 : 0) + (h.reverse ? -1 : 0),
      brake: h.brake,
    });
  }, []);

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
            label="좌회전"
            onHold={() => setHeld("left", true)}
            onRelease={() => setHeld("left", false)}
          >
            ‹
          </HoldButton>
          <HoldButton
            label="우회전"
            onHold={() => setHeld("right", true)}
            onRelease={() => setHeld("right", false)}
          >
            ›
          </HoldButton>
        </div>
      )}

      {/* Pedals */}
      <div className="touch-pedals absolute flex items-end gap-3">
        <HoldButton
          label="후진"
          onHold={() => setHeld("reverse", true)}
          onRelease={() => setHeld("reverse", false)}
        >
          ▼
        </HoldButton>
        <HoldButton
          label="브레이크 / 드리프트"
          variant="brake"
          onHold={() => setHeld("brake", true)}
          onRelease={() => setHeld("brake", false)}
        >
          ✋
        </HoldButton>
        <HoldButton
          label="가속"
          accent
          onHold={() => setHeld("gas", true)}
          onRelease={() => setHeld("gas", false)}
        >
          ▲
        </HoldButton>
      </div>

      {/* Scheme toggle + reset + recenter */}
      <div className="touch-tools absolute left-1/2 flex -translate-x-1/2 gap-2">
        <PillButton onClick={toggleScheme}>{scheme === "gui" ? "기울기: 꺼짐" : "기울기: 켜짐"}</PillButton>
        {scheme === "tilt" && (
          <PillButton onClick={() => (neutralRef.current = null)}>Recenter</PillButton>
        )}
        <button
          type="button"
          aria-label="차량 리셋"
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
  variant,
  children,
}: {
  onHold: () => void;
  onRelease: () => void;
  label: string;
  accent?: boolean;
  variant?: "brake";
  children: ReactNode;
}) {
  const look = accent
    ? "border-amber-300/60 bg-amber-500/30 text-amber-100 shadow-[0_0_24px_rgba(224,168,78,0.4)]"
    : variant === "brake"
      ? "border-amber-300/60 bg-amber-500/25 text-amber-100"
      : "border-white/20 bg-white/12 text-white/90";
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
      className={`touch-hold pointer-events-auto flex h-[5.5rem] w-[5.5rem] touch-none items-center justify-center rounded-full border text-4xl leading-none backdrop-blur transition active:brightness-125 ${look}`}
    >
      {children}
    </button>
  );
}
