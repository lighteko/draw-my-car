"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { getTrack, resolveTrackId } from "@/lib/tracks";
import { apiGet } from "@/lib/api";
import { usePlayer } from "@/lib/identity";
import { joinRoom, type RoomHandle } from "@/lib/realtime";
import { pushSnapshot, type Snapshot } from "@/components/RemoteVehicle";
import { RaceSceneClient } from "@/components/RaceSceneClient";
import type { RemoteRacer } from "@/components/RaceScene";
import type { Car } from "@/lib/cars";
import type {
  PresenceMeta,
  Quat,
  RaceSettings,
  RoomMessage,
  Standing,
  Vec3n,
} from "@/lib/roomTypes";

const ACTIVE_CAR_KEY = "dmc_active_car";

interface RaceConfig {
  trackId: string;
  laps: number;
  glb: string | null;
  ownerDeviceId: string;
  gateCount: number;
  spectator: boolean;
}

interface PlayerProgress {
  username: string;
  carName: string | null;
  lap: number;
  nextGate: number;
  finished: boolean;
  totalMs: number | null;
}

/** Slot = index of a device in the sorted player list — deterministic across clients. */
function slotOf(members: PresenceMeta[], id: string): number {
  const ordered = members
    .filter((m) => m.role === "player")
    .map((m) => m.deviceId)
    .sort();
  const i = ordered.indexOf(id);
  return i < 0 ? 0 : i;
}

function computeStandings(map: Map<string, PlayerProgress>, gateCount: number): Standing[] {
  const gc = gateCount || 1;
  const entries: Standing[] = [...map.entries()].map(([deviceId, p]) => ({
    deviceId,
    username: p.username,
    carName: p.carName,
    lap: p.lap,
    progress: p.lap * gc + ((p.nextGate - 1 + gc) % gc),
    finished: p.finished,
    totalMs: p.totalMs,
  }));
  entries.sort((a, b) => {
    if (a.finished && b.finished) return (a.totalMs ?? 0) - (b.totalMs ?? 0);
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
  return entries;
}

export default function RoomRacePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh w-full items-center justify-center bg-neutral-900 font-mono text-sm text-neutral-400">
          Lining up on the grid…
        </div>
      }
    >
      <RoomRace />
    </Suspense>
  );
}

function RoomRace() {
  const params = useParams<{ code: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { deviceId, username, ready } = usePlayer();

  const trackParam = search.get("track");
  const lapsParam = search.get("laps");

  const [config, setConfig] = useState<RaceConfig | null>(null);
  const [remotes, setRemotes] = useState<RemoteRacer[]>([]);
  const [standings, setStandings] = useState<Standing[]>([]);
  const [spawnIndex, setSpawnIndex] = useState<number | null>(null);

  const handleRef = useRef<RoomHandle | null>(null);
  const remoteBuffers = useRef<Map<string, Snapshot[]>>(new Map());
  const glbCache = useRef<Map<string, string | null>>(new Map());
  const progressMap = useRef<Map<string, PlayerProgress>>(new Map());
  const ownerRef = useRef("");
  const gateCountRef = useRef(0);

  // Resolve track/laps/car/owner once identity is ready.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      let trackId = trackParam;
      let laps = Number(lapsParam) || 0;
      let ownerDeviceId = "";
      try {
        const { room } = await apiGet<{ room: { settings: RaceSettings; ownerDeviceId: string } }>(
          `/api/rooms/${params.code}`,
        );
        ownerDeviceId = room.ownerDeviceId;
        if (!trackId) trackId = resolveTrackId(room.settings.trackId);
        if (!laps) laps = room.settings.laps;
      } catch {
        if (!trackId) trackId = resolveTrackId("random");
        if (!laps) laps = 3;
      }

      const carId = window.localStorage.getItem(ACTIVE_CAR_KEY);
      let glb: string | null = null;
      if (carId) {
        try {
          const { car } = await apiGet<{ car: Car }>(`/api/cars/${carId}`);
          glb = car.glbUrl;
        } catch {
          /* placeholder */
        }
      }

      if (cancelled) return;
      const gateCount = getTrack(trackId!).gates.length;
      const spectator = window.localStorage.getItem("dmc_role") === "spectator";
      ownerRef.current = ownerDeviceId;
      gateCountRef.current = gateCount;
      setConfig({ trackId: trackId!, laps, glb, ownerDeviceId, gateCount, spectator });
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, params.code, trackParam, lapsParam]);

  // Join the room channel and wire presence + messages.
  useEffect(() => {
    if (!config || !deviceId) return;

    const bumpOwner = (id: string, patch: Partial<PlayerProgress>) => {
      if (deviceId !== ownerRef.current) return;
      const cur =
        progressMap.current.get(id) ??
        ({ username: id.slice(0, 4), carName: null, lap: 0, nextGate: 1, finished: false, totalMs: null } as PlayerProgress);
      progressMap.current.set(id, { ...cur, ...patch });
      const next = computeStandings(progressMap.current, gateCountRef.current);
      setStandings(next);
      handleRef.current?.send({ kind: "standings", entries: next });
    };

    const onPresence = (members: PresenceMeta[]) => {
      setSpawnIndex((prev) => (prev == null ? slotOf(members, deviceId) : prev));

      const others = members.filter((m) => m.role === "player" && m.deviceId !== deviceId);
      void (async () => {
        await Promise.all(
          others.map(async (m) => {
            if (m.carId && !glbCache.current.has(m.carId)) {
              try {
                const { car } = await apiGet<{ car: Car }>(`/api/cars/${m.carId}`);
                glbCache.current.set(m.carId, car.glbUrl);
              } catch {
                glbCache.current.set(m.carId, null);
              }
            }
          }),
        );
        setRemotes(
          others.map((m) => ({
            deviceId: m.deviceId,
            glbUrl: m.carId ? glbCache.current.get(m.carId) ?? null : null,
            spawnIndex: slotOf(members, m.deviceId),
          })),
        );
      })();

      // Owner: seed usernames/car names for the leaderboard.
      if (deviceId === ownerRef.current) {
        members
          .filter((m) => m.role === "player")
          .forEach((m) => {
            const cur = progressMap.current.get(m.deviceId);
            progressMap.current.set(m.deviceId, {
              username: m.username,
              carName: m.carName,
              lap: cur?.lap ?? 0,
              nextGate: cur?.nextGate ?? 1,
              finished: cur?.finished ?? false,
              totalMs: cur?.totalMs ?? null,
            });
          });
      }
    };

    const onMessage = (msg: RoomMessage) => {
      if (msg.kind === "transform") {
        if (msg.deviceId === deviceId) return;
        let buf = remoteBuffers.current.get(msg.deviceId);
        if (!buf) {
          buf = [];
          remoteBuffers.current.set(msg.deviceId, buf);
        }
        pushSnapshot(buf, msg.p, msg.q);
      } else if (msg.kind === "standings") {
        setStandings(msg.entries);
      } else if (msg.kind === "progress") {
        bumpOwner(msg.deviceId, { lap: msg.lap, nextGate: msg.nextGate });
      } else if (msg.kind === "finished") {
        bumpOwner(msg.deviceId, { finished: true, totalMs: msg.totalMs });
      }
    };

    const carId = window.localStorage.getItem(ACTIVE_CAR_KEY);
    const meta: PresenceMeta = {
      deviceId,
      username,
      role: config.spectator ? "spectator" : "player",
      carId,
      carName: null,
      ready: true,
    };
    handleRef.current = joinRoom(params.code, meta, { onPresence, onMessage });

    // If presence is slow, don't block the start.
    const fallback = window.setTimeout(() => setSpawnIndex((v) => v ?? 0), 1500);

    return () => {
      clearTimeout(fallback);
      handleRef.current?.leave();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, deviceId]);

  // Callbacks handed to the scene (fresh each render; used via up-to-date closures).
  const isOwner = deviceId === config?.ownerDeviceId;

  const reportProgress = (lap: number, nextGate: number) => {
    if (isOwner) applyOwnerProgress(deviceId, { lap, nextGate });
    else handleRef.current?.send({ kind: "progress", deviceId, lap, nextGate });
  };
  const reportFinished = (totalMs: number) => {
    if (isOwner) applyOwnerProgress(deviceId, { finished: true, totalMs });
    else handleRef.current?.send({ kind: "finished", deviceId, totalMs });
  };
  const sendTransform = (p: Vec3n, q: Quat) => {
    handleRef.current?.send({ kind: "transform", deviceId, p, q });
  };

  function applyOwnerProgress(id: string, patch: Partial<PlayerProgress>) {
    const cur =
      progressMap.current.get(id) ??
      ({ username: id === deviceId ? username : id.slice(0, 4), carName: null, lap: 0, nextGate: 1, finished: false, totalMs: null } as PlayerProgress);
    progressMap.current.set(id, { ...cur, ...patch });
    const next = computeStandings(progressMap.current, gateCountRef.current);
    setStandings(next);
    handleRef.current?.send({ kind: "standings", entries: next });
  }

  if (!config || (!config.spectator && spawnIndex == null)) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-neutral-900 font-mono text-sm text-neutral-400">
        Lining up on the grid…
      </div>
    );
  }

  return (
    <RaceSceneClient
      trackId={config.trackId}
      carGlbUrl={config.glb}
      laps={config.laps}
      spawnIndex={spawnIndex ?? 0}
      selfDeviceId={deviceId}
      spectator={config.spectator}
      remotes={remotes}
      remoteBuffers={remoteBuffers}
      standings={standings}
      onTransform={sendTransform}
      onProgress={reportProgress}
      onFinished={reportFinished}
      onExit={() => router.push(`/r/${params.code}`)}
      exitLabel="Back to lobby"
    />
  );
}
