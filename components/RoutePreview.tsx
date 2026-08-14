"use client";

import { useMemo } from "react";
import type { Vec3 } from "@/lib/tracks";

/**
 * RoutePreview — the course shape as a top-down SVG outline, normalised to fit its box.
 *
 * Shared by the map lab and the lobby so a player picking a map sees the same drawing the
 * admin approved. The start gate is marked with a white dot; the rest are dropped once the
 * loop gets dense, since a 188-gate course would otherwise be a solid ring of circles.
 */

/** Above this many gates, drawing a dot per gate is noise rather than information. */
const DOT_LIMIT = 40;

export function RoutePreview({
  points,
  compact = false,
  accent = "#e0a84e",
}: {
  points: Vec3[];
  compact?: boolean;
  accent?: string;
}) {
  const { path, dots } = useMemo(() => {
    if (points.length === 0) return { path: "", dots: [] as string[] };
    const xs = points.map((point) => point[0]);
    const zs = points.map((point) => point[2]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    const projected = points.map(
      (point) =>
        `${12 + ((point[0] - minX) / span) * 96},${12 + ((point[2] - minZ) / span) * 96}`,
    );
    return {
      path: projected.join(" "),
      dots: points.length > DOT_LIMIT ? projected.slice(0, 1) : projected,
    };
  }, [points]);

  return (
    <div
      className={`overflow-hidden rounded-xl border border-white/10 bg-[#1b1209] ${
        compact ? "aspect-square" : "h-40"
      }`}
    >
      <svg viewBox="0 0 120 120" className="h-full w-full">
        <defs>
          <pattern id="route-grid" width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M 12 0 L 0 0 0 12" fill="none" stroke="rgba(255,255,255,.045)" strokeWidth=".5" />
          </pattern>
        </defs>
        <rect width="120" height="120" fill="url(#route-grid)" />
        <polygon
          points={path}
          fill={`${accent}10`}
          stroke={accent}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {dots.map((pair, index) => {
          const [cx, cy] = pair.split(",");
          return (
            <circle
              key={`${pair}-${index}`}
              cx={cx}
              cy={cy}
              r={index === 0 ? 3.5 : 2}
              fill={index === 0 ? "#fff" : accent}
            />
          );
        })}
      </svg>
    </div>
  );
}
