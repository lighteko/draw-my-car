"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { RapierRigidBody } from "@react-three/rapier";

/**
 * Hud — a DOM overlay (rendered *outside* the R3F Canvas) showing speed + controls.
 *
 * Speed is read from the chassis rigid body on an independent requestAnimationFrame
 * loop and written straight to a DOM node, so updating it never triggers a React
 * re-render (avoids per-frame render storms).
 */
export function Hud({ bodyRef }: { bodyRef: RefObject<RapierRigidBody | null> }) {
  const speedEl = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const body = bodyRef.current;
      const el = speedEl.current;
      if (body && el) {
        const v = body.linvel();
        const kmh = Math.hypot(v.x, v.y, v.z) * 3.6; // m/s -> km/h
        el.textContent = String(Math.round(kmh));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bodyRef]);

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Speedometer */}
      <div className="sim-speed absolute bottom-6 right-6 flex items-baseline gap-2 rounded-xl bg-black/55 px-5 py-3 font-mono text-white backdrop-blur">
        <span ref={speedEl} className="text-4xl font-bold tabular-nums">
          0
        </span>
        <span className="text-sm opacity-70">km/h</span>
      </div>

      {/* Controls help */}
      <div className="sim-help absolute bottom-6 left-6 rounded-xl bg-black/55 px-4 py-3 font-mono text-xs leading-relaxed text-white backdrop-blur">
        <div className="mb-1 font-semibold uppercase tracking-wide opacity-70">
          Controls
        </div>
        <div>
          <kbd>W</kbd> / <kbd>↑</kbd> throttle
        </div>
        <div>
          <kbd>S</kbd> / <kbd>↓</kbd> reverse
        </div>
        <div>
          <kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd> steer
        </div>
        <div>
          <kbd>Space</kbd> brake &nbsp;·&nbsp; <kbd>R</kbd> reset
        </div>
      </div>
    </div>
  );
}
