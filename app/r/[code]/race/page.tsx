"use client";

import { useParams, useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { TrackDef } from "@/lib/tracks";
import { resolveSharedTrack } from "@/lib/mapCatalog";
import { apiGet } from "@/lib/api";
import { usePlayer } from "@/lib/identity";
import { joinRoom, type RoomHandle } from "@/lib/realtime";
import { saveRaceHandoff } from "@/lib/raceHandoff";
import {
  gridMembership,
  isProgressUpdateAllowed,
  isRoomMessageForRace,
  progressScore,
} from "@/lib/roomRules";
import { collapsePresence, createPresenceSessionId } from "@/lib/presence";
import { pushSnapshot, type Snapshot } from "@/components/RemoteVehicle";
import { RaceSceneClient } from "@/components/RaceSceneClient";
import type { RemoteRacer } from "@/components/RaceScene";
import type { Car } from "@/lib/cars";
import type { PublicRoom } from "@/lib/rooms";
import type {
  GridSlot,
  PresenceMeta,
  Quat,
  RoomMessage,
  Standing,
  Vec3n,
} from "@/lib/roomTypes";

const ACTIVE_CAR_KEY = "dmc_active_car";

interface RaceConfig {
  track: TrackDef | null;
  raceId: string;
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

function computeStandings(map: Map<string, PlayerProgress>, gateCount: number): Standing[] {
  const entries: Standing[] = [...map.entries()].map(([deviceId, progress]) => ({
    deviceId,
    username: progress.username,
    carName: progress.carName,
    lap: progress.lap,
    progress: progressScore(progress, gateCount),
    finished: progress.finished,
    totalMs: progress.totalMs,
  }));
  entries.sort((a, b) => {
    if (a.finished && b.finished) return (a.totalMs ?? 0) - (b.totalMs ?? 0);
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
  return entries;
}

function isValidStandingSnapshot(
  entries: readonly Standing[],
  admittedIds: ReadonlySet<string>,
  gateCount: number,
  laps: number,
): boolean {
  const maxProgress = laps * Math.max(gateCount, 1);
  return entries.every(
    (entry) =>
      admittedIds.has(entry.deviceId) &&
      entry.lap >= 0 &&
      entry.lap <= laps &&
      entry.progress >= 0 &&
      entry.progress <= maxProgress &&
      (!entry.finished || (entry.lap === laps && entry.totalMs !== null)),
  );
}

export default function RoomRacePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh w-full items-center justify-center bg-[#17110b] font-mono text-sm text-[#d9c193]/70">
          출발선에 정렬하는 중…
        </div>
      }
    >
      <RoomRace />
    </Suspense>
  );
}

function RoomRace() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const { deviceId, username, ready } = usePlayer();

  const [config, setConfig] = useState<RaceConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [members, setMembers] = useState<PresenceMeta[]>([]);
  const [remotes, setRemotes] = useState<RemoteRacer[]>([]);
  const [standings, setStandings] = useState<Standing[]>([]);
  const [grid, setGrid] = useState<GridSlot[] | null>(null);
  const [startAt, setStartAt] = useState<number | null>(null);

  const handleRef = useRef<RoomHandle | null>(null);
  const remoteBuffers = useRef<Map<string, Snapshot[]>>(new Map());
  const glbCache = useRef<Map<string, string | null>>(new Map());
  const progressMap = useRef<Map<string, PlayerProgress>>(new Map());
  const localProgressRef = useRef({
    lap: 0,
    nextGate: 1,
    finished: false,
    totalMs: null as number | null,
  });
  const gridRef = useRef<GridSlot[]>([]);
  const primarySessionRef = useRef(false);
  const sessionId = useMemo(
    () => (deviceId ? createPresenceSessionId(deviceId) : ""),
    [deviceId],
  );

  // The server snapshot is the only race source. sessionStorage merely mirrors it for the
  // navigation handoff; a cold load and a reload always recover the same grid and clock.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const requestStartedAt = Date.now();
        const { room, serverNow } = await apiGet<{ room: PublicRoom; serverNow: number }>(
          `/api/rooms/${params.code}`,
        );
        const requestEndedAt = Date.now();
        if (room.status !== "racing" || !room.race) {
          throw new Error("진행 중인 레이스가 없습니다.");
        }

        const track = await resolveSharedTrack(room.race.trackId);
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

        const race = room.race;
        const clockOffset = serverNow - (requestStartedAt + requestEndedAt) / 2;
        const localStartAt = race.startAt - clockOffset;
        const admitted = gridMembership(race, deviceId) !== null;
        const spectator = window.localStorage.getItem("dmc_role") === "spectator" || !admitted;
        saveRaceHandoff(params.code, {
          raceId: race.raceId,
          trackId: race.trackId,
          laps: race.laps,
          grid: race.grid,
          ownerDeviceId: room.ownerDeviceId,
          startAt: race.startAt,
        });
        gridRef.current = race.grid;
        setGrid(race.grid);
        setStartAt(localStartAt);
        const nextConfig: RaceConfig = {
          track,
          raceId: race.raceId,
          laps: race.laps,
          glb,
          ownerDeviceId: room.ownerDeviceId,
          gateCount: track?.gates.length ?? 0,
          spectator,
        };
        setConfig(nextConfig);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "레이스 상태를 불러오지 못했습니다.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, params.code, ready]);

  useEffect(() => {
    if (!config || !deviceId) return;
    const isOwner = deviceId === config.ownerDeviceId;
    const admittedIds = new Set(gridRef.current.map((entry) => entry.deviceId));

    const verifyCanonicalRace = async () => {
      const { room } = await apiGet<{ room: PublicRoom }>(`/api/rooms/${params.code}`);
      if (room.status !== "racing" || room.race?.raceId !== config.raceId) {
        router.push(`/r/${params.code}?stay=1`);
      }
    };

    const broadcastStandings = () => {
      if (!isOwner || !primarySessionRef.current) return;
      const next = computeStandings(progressMap.current, config.gateCount);
      setStandings(next);
      void handleRef.current
        ?.send({
          kind: "standings",
          raceId: config.raceId,
          senderDeviceId: deviceId,
          entries: next,
        })
        .catch(() => {});
    };

    const bumpOwner = (
      id: string,
      patch: { lap?: number; nextGate?: number; finished?: boolean; totalMs?: number },
    ) => {
      if (!isOwner || !primarySessionRef.current || !admittedIds.has(id)) return;
      const current =
        progressMap.current.get(id) ??
        ({
          username: id === deviceId ? username : id.slice(0, 4),
          carName: null,
          lap: 0,
          nextGate: 1,
          finished: false,
          totalMs: null,
        } satisfies PlayerProgress);

      if (patch.lap !== undefined || patch.nextGate !== undefined) {
        const lap = patch.lap ?? current.lap;
        const nextGate = patch.nextGate ?? current.nextGate;
        if (!isProgressUpdateAllowed(current, { lap, nextGate }, config.gateCount, config.laps)) {
          return;
        }
      }
      if (patch.finished) {
        const targetLap = patch.lap ?? current.lap;
        if (
          targetLap < config.laps ||
          patch.totalMs === undefined ||
          !Number.isFinite(patch.totalMs) ||
          patch.totalMs < 0
        ) {
          return;
        }
      }
      progressMap.current.set(id, { ...current, ...patch });
      broadcastStandings();
    };

    const onPresence = (incoming: PresenceMeta[]) => {
      const collapsed = collapsePresence(incoming);
      primarySessionRef.current =
        collapsed.find((member) => member.deviceId === deviceId)?.sessionId === sessionId;
      setMembers(collapsed);
      if (!isOwner || !primarySessionRef.current) return;
      collapsed
        .filter((member) => member.role === "player" && admittedIds.has(member.deviceId))
        .forEach((member) => {
          const current = progressMap.current.get(member.deviceId);
          progressMap.current.set(member.deviceId, {
            username: member.username,
            carName: member.carName,
            lap: current?.lap ?? 0,
            nextGate: current?.nextGate ?? 1,
            finished: current?.finished ?? false,
            totalMs: current?.totalMs ?? null,
          });
        });
      broadcastStandings();
      void handleRef.current
        ?.send({
          kind: "progress_request",
          raceId: config.raceId,
          senderDeviceId: deviceId,
        })
        .catch(() => {});
    };

    const onMessage = (message: RoomMessage) => {
      if (message.kind === "room_changed") {
        void verifyCanonicalRace().catch(() => {});
        return;
      }
      if (message.kind === "player_state") return;
      if (!isRoomMessageForRace(message, config.raceId)) return;

      if (message.kind === "transform") {
        if (
          message.deviceId === deviceId ||
          message.senderDeviceId !== message.deviceId ||
          !admittedIds.has(message.deviceId)
        ) {
          return;
        }
        let buffer = remoteBuffers.current.get(message.deviceId);
        if (!buffer) {
          buffer = [];
          remoteBuffers.current.set(message.deviceId, buffer);
        }
        pushSnapshot(buffer, message.p, message.q);
      } else if (message.kind === "standings") {
        if (
          message.senderDeviceId === config.ownerDeviceId &&
          isValidStandingSnapshot(message.entries, admittedIds, config.gateCount, config.laps)
        ) {
          setStandings(message.entries);
        }
      } else if (message.kind === "progress") {
        if (message.senderDeviceId === message.deviceId) {
          bumpOwner(message.deviceId, { lap: message.lap, nextGate: message.nextGate });
        }
      } else if (message.kind === "finished") {
        if (message.senderDeviceId === message.deviceId) {
          bumpOwner(message.deviceId, {
            lap: message.lap,
            nextGate: message.nextGate,
            finished: true,
            totalMs: message.totalMs,
          });
        }
      } else if (message.kind === "progress_request") {
        if (
          message.senderDeviceId !== config.ownerDeviceId ||
          config.spectator ||
          !primarySessionRef.current
        ) {
          return;
        }
        const local = localProgressRef.current;
        void handleRef.current
          ?.send({
            kind: "progress_state",
            raceId: config.raceId,
            senderDeviceId: deviceId,
            deviceId,
            ...local,
          })
          .catch(() => {});
      } else if (message.kind === "progress_state") {
        if (message.senderDeviceId !== message.deviceId) return;
        bumpOwner(message.deviceId, {
          lap: message.lap,
          nextGate: message.nextGate,
          ...(message.finished && message.totalMs !== null
            ? { finished: true, totalMs: message.totalMs }
            : {}),
        });
      }
    };

    const carId = window.localStorage.getItem(ACTIVE_CAR_KEY);
    const meta: PresenceMeta = {
      deviceId,
      sessionId,
      username,
      role: config.spectator ? "spectator" : "player",
      carId,
      carName: null,
      ready: true,
    };
    const handle = joinRoom(params.code, meta, {
      onPresence,
      onMessage,
      onStatus: (status) => {
        if (status === "connected") void verifyCanonicalRace().catch(() => {});
      },
    });
    handleRef.current = handle;
    return () => {
      primarySessionRef.current = false;
      handle.leave();
      handleRef.current = null;
    };
  }, [config, deviceId, params.code, router, sessionId, username]);

  // Render only server-admitted racers. A late joiner absent from the persisted grid is a
  // spectator and cannot manufacture a trailing slot.
  useEffect(() => {
    if (!deviceId || !grid) return;
    let cancelled = false;
    const admittedIds = new Set(grid.map((entry) => entry.deviceId));
    const byDevice = new Map(members.map((member) => [member.deviceId, member]));
    const others = grid
      .filter((entry) => entry.deviceId !== deviceId)
      .map((entry) => byDevice.get(entry.deviceId))
      .filter((member): member is PresenceMeta => Boolean(member));
    void (async () => {
      await Promise.all(
        others.map(async (member) => {
          if (member.carId && !glbCache.current.has(member.carId)) {
            try {
              const { car } = await apiGet<{ car: Car }>(`/api/cars/${member.carId}`);
              glbCache.current.set(member.carId, car.glbUrl);
            } catch {
              glbCache.current.set(member.carId, null);
            }
          }
        }),
      );
      if (cancelled) return;
      setRemotes(
        others
          .filter((member) => admittedIds.has(member.deviceId))
          .map((member) => ({
            deviceId: member.deviceId,
            glbUrl: member.carId ? glbCache.current.get(member.carId) ?? null : null,
            spawnIndex: gridMembership(grid, member.deviceId)?.slot ?? 0,
          })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, grid, members]);

  const spawnIndex = useMemo(
    () => (grid && deviceId ? gridMembership(grid, deviceId)?.slot ?? null : null),
    [deviceId, grid],
  );
  const isOwner = deviceId === config?.ownerDeviceId;

  const applyOwnerProgress = (
    id: string,
    patch: Partial<Pick<PlayerProgress, "lap" | "nextGate" | "finished" | "totalMs">>,
  ) => {
    if (
      !config ||
      !primarySessionRef.current ||
      !gridRef.current.some((entry) => entry.deviceId === id)
    ) {
      return;
    }
    const current =
      progressMap.current.get(id) ??
      ({
        username: id === deviceId ? username : id.slice(0, 4),
        carName: null,
        lap: 0,
        nextGate: 1,
        finished: false,
        totalMs: null,
      } satisfies PlayerProgress);
    progressMap.current.set(id, { ...current, ...patch });
    const next = computeStandings(progressMap.current, config.gateCount);
    setStandings(next);
    void handleRef.current
      ?.send({
        kind: "standings",
        raceId: config.raceId,
        senderDeviceId: deviceId,
        entries: next,
      })
      .catch(() => {});
  };

  const reportProgress = (lap: number, nextGate: number) => {
    if (!config || !primarySessionRef.current) return;
    localProgressRef.current = { ...localProgressRef.current, lap, nextGate };
    if (isOwner) applyOwnerProgress(deviceId, { lap, nextGate });
    else {
      void handleRef.current
        ?.send({
          kind: "progress",
          raceId: config.raceId,
          senderDeviceId: deviceId,
          deviceId,
          lap,
          nextGate,
        })
        .catch(() => {});
    }
  };
  const reportFinished = (totalMs: number) => {
    if (!config || !primarySessionRef.current) return;
    const completed = { ...localProgressRef.current, finished: true, totalMs };
    localProgressRef.current = completed;
    if (isOwner) {
      applyOwnerProgress(deviceId, {
        lap: completed.lap,
        nextGate: completed.nextGate,
        finished: true,
        totalMs,
      });
    }
    else {
      void handleRef.current
        ?.send({
          kind: "finished",
          raceId: config.raceId,
          senderDeviceId: deviceId,
          deviceId,
          lap: completed.lap,
          nextGate: completed.nextGate,
          totalMs,
        })
        .catch(() => {});
    }
  };
  const sendTransform = (position: Vec3n, rotation: Quat) => {
    if (!config || config.spectator || !primarySessionRef.current) return;
    void handleRef.current
      ?.send({
        kind: "transform",
        raceId: config.raceId,
        senderDeviceId: deviceId,
        deviceId,
        p: position,
        q: rotation,
      })
      .catch(() => {});
  };

  if (loadError) {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-[#17110b] px-6 text-center font-mono text-sm text-[#d9c193]/70">
        <p>{loadError}</p>
        <button
          type="button"
          onClick={() => router.push(`/r/${params.code}?stay=1`)}
          className="text-amber-400 underline"
        >
          대기실로
        </button>
      </div>
    );
  }

  if (!config || startAt == null || (!config.spectator && spawnIndex == null)) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-[#17110b] font-mono text-sm text-[#d9c193]/70">
        출발선에 정렬하는 중…
      </div>
    );
  }

  if (!config.track) {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-[#17110b] text-center font-mono text-sm text-[#d9c193]/70">
        <p>이 방의 맵을 더 이상 사용할 수 없습니다.</p>
        <button
          type="button"
          onClick={() => router.push(`/r/${params.code}?stay=1`)}
          className="text-amber-400 underline"
        >
          대기실로
        </button>
      </div>
    );
  }

  return (
    <RaceSceneClient
      track={config.track}
      carGlbUrl={config.glb}
      laps={config.laps}
      spawnIndex={spawnIndex ?? 0}
      startAt={startAt}
      selfDeviceId={deviceId}
      spectator={config.spectator}
      remotes={remotes}
      remoteBuffers={remoteBuffers}
      standings={standings}
      onTransform={sendTransform}
      onProgress={reportProgress}
      onFinished={reportFinished}
      onExit={() => router.push(`/r/${params.code}?stay=1`)}
      exitLabel="대기실로"
    />
  );
}
