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
}

export function Minimap({
  track,
  selfBody,
  remoteBuffers,
}: {
  track: TrackDef;
  selfBody: RefObject<RapierRigidBody | null>;
  remoteBuffers: RefObject<Map<string, Snapshot[]>>;
}) {
  const { project, gatePath } = useMemo(() => {
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
    return { project, gatePath };
  }, [track]);

  const [dots, setDots] = useState<Dot[]>([]);

  useEffect(() => {
    const id = setInterval(() => {
      const list: Dot[] = [];
      const body = selfBody.current;
      if (body) {
        const t = body.translation();
        list.push({ id: "self", ...project(t.x, t.z), self: true });
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
    <div className="pointer-events-none absolute right-4 top-24 z-10 rounded-lg bg-black/40 p-1 backdrop-blur">
      <svg width={SIZE} height={SIZE} className="block">
        <polygon
          points={gatePath}
          fill="none"
          stroke="rgba(255,255,255,0.35)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {dots.map((d) => (
          <circle
            key={d.id}
            cx={d.x}
            cy={d.y}
            r={d.self ? 4 : 3}
            fill={d.self ? "#34d399" : "#f87171"}
            stroke="rgba(0,0,0,0.5)"
            strokeWidth={1}
          />
        ))}
      </svg>
    </div>
  );
}
