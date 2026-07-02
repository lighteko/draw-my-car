"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { resolveTrackId } from "@/lib/tracks";
import { apiGet } from "@/lib/api";
import { RaceSceneClient } from "@/components/RaceSceneClient";
import type { Car } from "@/lib/cars";

const ACTIVE_CAR_KEY = "dmc_active_car";

function Preparing() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 font-mono text-sm text-neutral-400">
      Preparing race…
    </div>
  );
}

/**
 * /race/[trackId] — solo practice on a track. Fully local (no room / Realtime needed),
 * so the race loop is verifiable on its own. Car comes from ?car=<id> or the active car.
 */
export default function PracticePage() {
  return (
    <Suspense fallback={<Preparing />}>
      <Practice />
    </Suspense>
  );
}

function Practice() {
  const params = useParams<{ trackId: string }>();
  const search = useSearchParams();
  const router = useRouter();

  const laps = Number(search.get("laps")) || 3;
  const [config, setConfig] = useState<{ trackId: string; glb: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const trackId = resolveTrackId(params.trackId);
      const carId = search.get("car") ?? window.localStorage.getItem(ACTIVE_CAR_KEY);
      let glb: string | null = null;
      if (carId) {
        try {
          const { car } = await apiGet<{ car: Car }>(`/api/cars/${carId}`);
          glb = car.glbUrl;
        } catch {
          /* fall back to placeholder car */
        }
      }
      if (!cancelled) setConfig({ trackId, glb });
    })();
    return () => {
      cancelled = true;
    };
  }, [params.trackId, search]);

  if (!config) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 font-mono text-sm text-neutral-400">
        Preparing race…
      </div>
    );
  }

  return (
    <RaceSceneClient
      trackId={config.trackId}
      carGlbUrl={config.glb}
      laps={laps}
      onExit={() => router.push("/")}
      exitLabel="Back to garage"
    />
  );
}
