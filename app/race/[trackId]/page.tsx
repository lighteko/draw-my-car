"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { TrackDef } from "@/lib/tracks";
import { resolveSoloTrack } from "@/lib/mapCatalog";
import { apiGet } from "@/lib/api";
import { RaceSceneClient } from "@/components/RaceSceneClient";
import type { Car } from "@/lib/cars";

const ACTIVE_CAR_KEY = "dmc_active_car";

function Preparing() {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-[#17110b] font-mono text-sm text-[#d9c193]/70">
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

  const laps = Number(search.get("laps")) || 1;
  // The map lab links here with ?admin=1 to test-drive a map with the authoring panels;
  // a race started from the garage is a plain practice run. (The panels' saves are
  // admin-guarded server-side, so this flag only decides what the UI offers.)
  const fromMapLab = search.get("admin") === "1";
  const [config, setConfig] = useState<{
    track: TrackDef | null;
    glb: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const track = await resolveSoloTrack(params.trackId);
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
      if (!cancelled) setConfig({ track, glb });
    })();
    return () => {
      cancelled = true;
    };
  }, [params.trackId, search]);

  if (!config) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-[#17110b] font-mono text-sm text-[#d9c193]/70">
        레이스 준비 중…
      </div>
    );
  }

  // No map matched and the library is empty — nothing to race on until an admin uploads one.
  if (!config.track) {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-[#17110b] text-center font-mono text-sm text-[#d9c193]/70">
        <p>아직 사용할 수 있는 맵이 없습니다.</p>
        <Link href={fromMapLab ? "/admin/maps" : "/"} className="text-amber-400 underline">
          {fromMapLab ? "맵 제작실로" : "차고로"}
        </Link>
      </div>
    );
  }

  return (
    <RaceSceneClient
      track={config.track}
      adminMode={fromMapLab}
      carGlbUrl={config.glb}
      laps={laps}
      onExit={() => router.push(fromMapLab ? "/admin/maps" : "/")}
      exitLabel={fromMapLab ? "맵 제작실로" : "차고로"}
    />
  );
}
