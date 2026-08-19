"use client";

import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { RapierRigidBody } from "@react-three/rapier";
import type { TrackDef } from "@/lib/tracks";
import type { Snapshot } from "./RemoteVehicle";

/**
 * Minimap — a top-down SVG overlay of the gate loop with live car dots. DOM-only; it polls
 * positions on a light interval so its re-renders never touch the WebGL tree.
 */

const SIZE = 132;
const PAD = 12;

interface Dot {
  id: string;
  x: number;
  y: number;
  self: boolean;
  angle?: number;
}

export function Minimap({
  track,
  selfBody,
  remoteBuffers,
  nextGateIndex,
}: {
  track: TrackDef;
  selfBody: RefObject<RapierRigidBody | null>;
  remoteBuffers: RefObject<Map<string, Snapshot[]>>;
  nextGateIndex?: number;
}) {
  const { project, gatePath, start } = useMemo(() => {
    const xs = track.gates.map((g) => g.position[0]);
    const zs = track.gates.map((g) => g.position[2]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = (SIZE - PAD * 2) / Math.max(maxX - minX, maxZ - minZ, 1);
    const project = (x: number, z: number) => ({
      x: SIZE / 2 + (x - cx) * scale,
      y: SIZE / 2 + (z - cz) * scale,
    });
    const gatePath = track.gates
      .map((g) => {
        const p = project(g.position[0], g.position[2]);
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      })
      .join(" ");
    // Start/finish marker: gate 0's pixel spot, plus the screen angle of its heading. The
    // projection puts world +X right and +Z down, so the heading maps to (sin, cos); the
    // quarter turn lays the marker's long edge across the track, matching the 3D mat.
    const gate0 = track.gates[0];
    const start = gate0
      ? {
          ...project(gate0.position[0], gate0.position[2]),
          angle:
            (Math.atan2(Math.cos(gate0.rotationY), Math.sin(gate0.rotationY)) * 180) / Math.PI +
            90,
        }
      : null;
    return { project, gatePath, start };
  }, [track]);

  const [dots, setDots] = useState<Dot[]>([]);

  // Separate self and remote dots for layering: draw remotes first, self last (on top).
  const remoteDots = dots.filter((d) => !d.self);
  const selfDot = dots.find((d) => d.self);

  // Determine next gate marker position if provided and index is valid.
  const nextGateMarker = useMemo(() => {
    if (nextGateIndex !== undefined && track.gates[nextGateIndex]) {
      const gate = track.gates[nextGateIndex];
      return project(gate.position[0], gate.position[2]);
    }
    return null;
  }, [nextGateIndex, track, project]);

  useEffect(() => {
    const id = setInterval(() => {
      const list: Dot[] = [];
      const body = selfBody.current;
      if (body) {
        const t = body.translation();
        const rot = body.rotation();
        // Extract yaw from quaternion by applying it to the forward vector (0, 0, 1).
        // Quaternion format is (x, y, z, w). Compute forward vector through rotation:
        // forward.x = 2 * (w*y + x*z), forward.z = 1 - 2 * (x² + y²)
        const forward = {
          x: 2 * (rot.w * rot.y + rot.x * rot.z),
          z: 1 - 2 * (rot.x * rot.x + rot.y * rot.y),
        };
        const yaw = Math.atan2(forward.x, forward.z);
        // Convert world yaw to screen angle using the same pattern as the start marker:
        // world yaw maps through (sin, cos) to screen angle.
        const angle = (Math.atan2(Math.cos(yaw), Math.sin(yaw)) * 180) / Math.PI + 90;
        list.push({ id: "self", ...project(t.x, t.z), self: true, angle });
      }
      remoteBuffers.current?.forEach((buf, key) => {
        const last = buf[buf.length - 1];
        if (last) list.push({ id: key, ...project(last.p[0], last.p[2]), self: false });
      });
      setDots(list);
    }, 60);
    return () => clearInterval(id);
  }, [project, selfBody, remoteBuffers]);

  return (
    <div className="race-minimap pointer-events-none absolute right-4 top-24 z-10 rounded-lg bg-black/40 p-1 backdrop-blur">
      <svg width={SIZE} height={SIZE} className="block">
        <defs>
          <pattern id="mm-checker" width={6} height={6} patternUnits="userSpaceOnUse">
            <rect width={6} height={6} fill="#f8f5ee" />
            <rect width={3} height={3} fill="#191410" />
            <rect x={3} y={3} width={3} height={3} fill="#191410" />
          </pattern>
        </defs>
        <polygon
          points={gatePath}
          fill="none"
          stroke="rgba(255,255,255,0.35)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {start && (
          <rect
            x={start.x - 6}
            y={start.y - 4}
            width={12}
            height={8}
            fill="url(#mm-checker)"
            stroke="rgba(0,0,0,0.55)"
            strokeWidth={1}
            transform={`rotate(${start.angle.toFixed(1)} ${start.x.toFixed(1)} ${start.y.toFixed(1)})`}
          />
        )}
        {/* Draw remote player dots first (visually subordinate) */}
        {remoteDots.map((d) => (
          <circle
            key={d.id}
            cx={d.x}
            cy={d.y}
            r={3}
            fill="#f87171"
            stroke="rgba(0,0,0,0.5)"
            strokeWidth={1}
          />
        ))}
        {/* Draw next gate marker if provided */}
        {nextGateMarker && (
          <circle
            cx={nextGateMarker.x}
            cy={nextGateMarker.y}
            r={6}
            fill="none"
            stroke="rgba(255,235,59,0.7)"
            strokeWidth={2}
          />
        )}
        {/* Draw self player arrow last (on top, never hidden) */}
        {selfDot && selfDot.angle !== undefined && (
          <polygon
            points="0,-4 -3.5,3 3.5,3"
            fill="#34d399"
            stroke="rgba(0,0,0,0.5)"
            strokeWidth={1}
            transform={`translate(${selfDot.x.toFixed(1)},${selfDot.y.toFixed(1)}) rotate(${selfDot.angle.toFixed(1)})`}
          />
        )}
      </svg>
    </div>
  );
}
