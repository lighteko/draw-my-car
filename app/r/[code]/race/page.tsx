"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { resolveTrackId } from "@/lib/tracks";
import { apiGet } from "@/lib/api";
import { RaceSceneClient } from "@/components/RaceSceneClient";
import type { Car } from "@/lib/cars";
import type { RaceSettings } from "@/lib/roomTypes";

const ACTIVE_CAR_KEY = "dmc_active_car";

function LiningUp() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 font-mono text-sm text-neutral-400">
      Lining up on the grid…
    </div>
  );
}

/**
 * /r/[code]/race — the room's race. Track + laps come from the start broadcast (query
 * params) so "random" resolves to the same track for everyone; a direct load / refresh
 * falls back to the persisted room settings. Remote ghosts + synced standings land in the
 * multiplayer phase — for now each client races the shared track locally.
 */
export default function RoomRacePage() {
  return (
    <Suspense fallback={<LiningUp />}>
      <RoomRace />
    </Suspense>
  );
}

function RoomRace() {
  const params = useParams<{ code: string }>();
  const search = useSearchParams();
  const router = useRouter();

  const [config, setConfig] = useState<{ trackId: string; laps: number; glb: string | null } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Authoritative values from the start message; else the persisted room settings.
      let trackId = search.get("track");
      let laps = Number(search.get("laps")) || 0;
      if (!trackId || !laps) {
        try {
          const { room } = await apiGet<{ room: { settings: RaceSettings } }>(
            `/api/rooms/${params.code}`,
          );
          trackId = trackId ?? resolveTrackId(room.settings.trackId);
          laps = laps || room.settings.laps;
        } catch {
          trackId = trackId ?? resolveTrackId("random");
          laps = laps || 3;
        }
      }

      const carId = window.localStorage.getItem(ACTIVE_CAR_KEY);
      let glb: string | null = null;
      if (carId) {
        try {
          const { car } = await apiGet<{ car: Car }>(`/api/cars/${carId}`);
          glb = car.glbUrl;
        } catch {
          /* placeholder car */
        }
      }

      if (!cancelled) setConfig({ trackId: trackId!, laps, glb });
    })();
    return () => {
      cancelled = true;
    };
  }, [params.code, search]);

  if (!config) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 font-mono text-sm text-neutral-400">
        Lining up on the grid…
      </div>
    );
  }

  return (
    <RaceSceneClient
      trackId={config.trackId}
      carGlbUrl={config.glb}
      laps={config.laps}
      onExit={() => router.push(`/r/${params.code}`)}
    />
  );
}
