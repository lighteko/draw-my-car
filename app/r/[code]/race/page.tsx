"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { TrackDef } from "@/lib/tracks";
import { resolveSharedTrack } from "@/lib/mapCatalog";
import { apiGet } from "@/lib/api";
import { usePlayer } from "@/lib/identity";
import { joinRoom, type RoomHandle } from "@/lib/realtime";
import { loadRaceHandoff, saveRaceHandoff } from "@/lib/raceHandoff";
import { pushSnapshot, type Snapshot } from "@/components/RemoteVehicle";
import { RaceSceneClient } from "@/components/RaceSceneClient";
import type { RemoteRacer } from "@/components/RaceScene";
import type { Car } from "@/lib/cars";
import type {
  GridSlot,
  PresenceMeta,
  Quat,
  RaceSettings,
  RoomMessage,
  Standing,
  Vec3n,
} from "@/lib/roomTypes";

const ACTIVE_CAR_KEY = "dmc_active_car";

/** Lead between the "go" broadcast and the shared start, so every client sees the 3-2-1. */
const GO_LEAD_MS = 3500;
/** Owner: stop waiting for missing racers after this long and start with whoever arrived. */
const GRID_WAIT_MS = 8000;
/** Everyone: if no "go" ever arrives (owner gone), fall back to a local start. */
const NO_GO_FALLBACK_MS = 12000;

interface RaceConfig {
  /** null when the room's map is gone and the library has nothing to fall back to. */
  track: TrackDef | null;
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

/**
 * Spawn slots come from the owner-assigned grid (unique by construction). Anyone who
 * wasn't in the grid (direct URL join) gets a deterministic trailing slot.
 */
function slotMap(grid: GridSlot[], playerIds: string[]): Map<string, number> {
  const map = new Map<string, number>(grid.map((g) => [g.deviceId, g.slot]));
  playerIds
    .filter((id) => !map.has(id))
    .sort()
    .forEach((id, i) => map.set(id, grid.length + i));
  return map;
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
  const search = useSearchParams();
  const router = useRouter();
  const { deviceId, username, ready } = usePlayer();

  const trackParam = search.get("track");
  const lapsParam = search.get("laps");

  const [config, setConfig] = useState<RaceConfig | null>(null);
  const [members, setMembers] = useState<PresenceMeta[]>([]);
  const [remotes, setRemotes] = useState<RemoteRacer[]>([]);
  const [standings, setStandings] = useState<Standing[]>([]);
  const [grid, setGrid] = useState<GridSlot[] | null>(null);
  const [startAt, setStartAt] = useState<number | null>(null);

  const handleRef = useRef<RoomHandle | null>(null);
  const remoteBuffers = useRef<Map<string, Snapshot[]>>(new Map());
  const glbCache = useRef<Map<string, string | null>>(new Map());
  const progressMap = useRef<Map<string, PlayerProgress>>(new Map());
  const ownerRef = useRef("");
  const gateCountRef = useRef(0);
  const gridRef = useRef<GridSlot[] | null>(null);
  const goStartAtRef = useRef<number | null>(null);

  // Resolve track/laps/car/owner/grid once identity is ready. The lobby handoff is the
  // preferred source (it carries the owner-assigned grid); URL and the room API fill the
  // gaps for cold loads without one.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const handoff = loadRaceHandoff(params.code);
      let trackId = handoff?.trackId ?? trackParam;
      let laps = handoff?.laps ?? (Number(lapsParam) || 0);
      let ownerDeviceId = handoff?.ownerDeviceId ?? "";
      if (!trackId || !laps || !ownerDeviceId) {
        try {
          const { room } = await apiGet<{
            room: { settings: RaceSettings; ownerDeviceId: string };
          }>(`/api/rooms/${params.code}`);
          if (!ownerDeviceId) ownerDeviceId = room.ownerDeviceId;
          if (!trackId) trackId = room.settings.trackId;
          if (!laps) laps = room.settings.laps;
        } catch {
          if (!laps) laps = 1;
        }
      }
      // Everyone resolves the same way: the id the owner broadcast, or — if that map is
      // gone — the newest map, so a fallback still lands the whole room on one track.
      const track = await resolveSharedTrack(trackId ?? "");

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
      if (handoff?.grid?.length) {
        gridRef.current = handoff.grid;
        setGrid(handoff.grid);
      }
      if (handoff?.startAt) {
        // A reload mid-race rejoins on the shared clock instead of waiting for "go".
        goStartAtRef.current = handoff.startAt;
        setStartAt(handoff.startAt);
      }
      const gateCount = track?.gates.length ?? 0;
      const spectator = window.localStorage.getItem("dmc_role") === "spectator";
      ownerRef.current = ownerDeviceId;
      gateCountRef.current = gateCount;
      setConfig({ track, laps, glb, ownerDeviceId, gateCount, spectator });
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, params.code, trackParam, lapsParam]);

  // Join the room channel and run the start protocol: the owner waits for the grid to
  // assemble (bounded by GRID_WAIT_MS), then broadcasts "go" with a shared wall-clock
  // startAt; everyone else holds at the grid until it arrives.
  useEffect(() => {
    if (!config || !deviceId) return;
    const isOwner = deviceId === ownerRef.current;

    const persistHandoff = (at: number) => {
      saveRaceHandoff(params.code, {
        trackId: config.track?.id ?? "",
        laps: config.laps,
        grid: gridRef.current ?? [],
        ownerDeviceId: config.ownerDeviceId,
        startAt: at,
      });
    };

    const applyGrid = (g: GridSlot[]) => {
      if (gridRef.current && JSON.stringify(gridRef.current) === JSON.stringify(g)) return;
      gridRef.current = g;
      setGrid(g);
    };

    // Owner: broadcast the shared start. Idempotent — repeat calls re-send the same
    // startAt, so stragglers and reloads converge on one clock.
    const issueGo = () => {
      const g = gridRef.current;
      if (!isOwner || !g) return;
      const at = goStartAtRef.current ?? Date.now() + GO_LEAD_MS;
      goStartAtRef.current = at;
      setStartAt(at);
      persistHandoff(at);
      void handleRef.current?.send({ kind: "go", grid: g, startAt: at });
    };

    const bumpOwner = (id: string, patch: Partial<PlayerProgress>) => {
      if (deviceId !== ownerRef.current) return;
      const cur =
        progressMap.current.get(id) ??
        ({
          username: id.slice(0, 4),
          carName: null,
          lap: 0,
          nextGate: 1,
          finished: false,
          totalMs: null,
        } as PlayerProgress);
      progressMap.current.set(id, { ...cur, ...patch });
      const next = computeStandings(progressMap.current, gateCountRef.current);
      setStandings(next);
      handleRef.current?.send({ kind: "standings", entries: next });
    };

    const onPresence = (incoming: PresenceMeta[]) => {
      setMembers(incoming);

      if (isOwner) {
        // Seed usernames/car names for the leaderboard.
        incoming
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

        if (goStartAtRef.current != null) {
          issueGo(); // re-broadcast so whoever just arrived gets the shared clock
        } else if (gridRef.current) {
          const present = new Set(
            incoming.filter((m) => m.role === "player").map((m) => m.deviceId),
          );
          if (gridRef.current.every((s) => present.has(s.deviceId))) issueGo();
        }
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
      } else if (msg.kind === "go") {
        applyGrid(msg.grid);
        if (goStartAtRef.current !== msg.startAt) {
          goStartAtRef.current = msg.startAt;
          setStartAt(msg.startAt);
          persistHandoff(msg.startAt);
        }
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

    // Owner: grace window for racers still navigating, then start with whoever is here.
    const goTimer = isOwner ? window.setTimeout(issueGo, GRID_WAIT_MS) : undefined;
    // Everyone: no "go" at all (owner gone / never reachable) → race locally.
    const fallbackTimer = window.setTimeout(() => {
      if (goStartAtRef.current != null) return;
      if (!gridRef.current) {
        gridRef.current = [{ deviceId, slot: 0 }];
        setGrid(gridRef.current);
      }
      const at = Date.now() + GO_LEAD_MS;
      goStartAtRef.current = at;
      setStartAt(at);
    }, NO_GO_FALLBACK_MS);

    return () => {
      window.clearTimeout(goTimer);
      window.clearTimeout(fallbackTimer);
      handleRef.current?.leave();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, deviceId]);

  // Ghost cars for everyone else, spawn slots resolved from the authoritative grid.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    const players = members.filter((m) => m.role === "player");
    const slots = slotMap(grid ?? [], players.map((m) => m.deviceId));
    const others = players.filter((m) => m.deviceId !== deviceId);
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
      if (cancelled) return;
      setRemotes(
        others.map((m) => ({
          deviceId: m.deviceId,
          glbUrl: m.carId ? glbCache.current.get(m.carId) ?? null : null,
          spawnIndex: slots.get(m.deviceId) ?? 0,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [members, grid, deviceId]);

  // Own spawn slot — null until the grid is known, so the scene never mounts at slot 0
  // only to teleport later.
  const spawnIndex = useMemo(() => {
    if (!grid || !deviceId) return null;
    const playerIds = new Set(
      members.filter((m) => m.role === "player").map((m) => m.deviceId),
    );
    playerIds.add(deviceId);
    return slotMap(grid, [...playerIds]).get(deviceId) ?? 0;
  }, [grid, members, deviceId]);

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
      ({
        username: id === deviceId ? username : id.slice(0, 4),
        carName: null,
        lap: 0,
        nextGate: 1,
        finished: false,
        totalMs: null,
      } as PlayerProgress);
    progressMap.current.set(id, { ...cur, ...patch });
    const next = computeStandings(progressMap.current, gateCountRef.current);
    setStandings(next);
    handleRef.current?.send({ kind: "standings", entries: next });
  }

  if (!config || (!config.spectator && spawnIndex == null)) {
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
          onClick={() => router.push(`/r/${params.code}`)}
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
      onExit={() => router.push(`/r/${params.code}`)}
      exitLabel="대기실로"
    />
  );
}
