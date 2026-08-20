"use client";

import QRCode from "qrcode";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePlayer } from "@/lib/identity";
import { hasBrowserSupabase } from "@/lib/supabase-browser";
import { enterFullscreen, isTouchDevice, useAutoFullscreen } from "@/lib/fullscreen";
import {
  joinRoom,
  type RoomConnectionStatus,
  type RoomHandle,
} from "@/lib/realtime";
import { saveRaceHandoff } from "@/lib/raceHandoff";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import type { TrackDef } from "@/lib/tracks";
import { fetchMaps, RANDOM_TRACK_ID } from "@/lib/mapCatalog";
import { estimateRaceSeconds, lapDistance } from "@/lib/tracks";
import { RoutePreview } from "./RoutePreview";
import {
  LAP_OPTIONS,
  MAX_PLAYER_OPTIONS,
  type PresenceMeta,
  type RaceSettings,
  type Role,
  type RoomMessage,
} from "@/lib/roomTypes";
import type { Car } from "@/lib/cars";
import type { PublicRoom } from "@/lib/rooms";
import { collapsePresence, createPresenceSessionId } from "@/lib/presence";

const ACTIVE_CAR_KEY = "dmc_active_car";

/** Well inside the window the room browser uses to decide a host has gone quiet. */
const OCCUPANCY_REPORT_MS = 15_000;

/**
 * Lobby — presence roster + owner race settings + share (link/QR), all over one Realtime
 * channel. The owner is the only one who can edit settings; changes broadcast live and are
 * persisted so a share-link cold load sees the current config. Starting the race is wired
 * in the race phase (the button is present but inert here).
 */
export function Lobby({
  initialRoom,
  autoJoin,
}: {
  initialRoom: PublicRoom;
  autoJoin: boolean;
}) {
  const code = initialRoom.code;
  const ownerDeviceId = initialRoom.ownerDeviceId;
  const { deviceId, username, ready } = usePlayer();
  const router = useRouter();
  useAutoFullscreen();

  const [room, setRoom] = useState<PublicRoom>(initialRoom);
  const [members, setMembers] = useState<PresenceMeta[]>([]);
  const [cars, setCars] = useState<Car[]>([]);
  const [maps, setMaps] = useState<TrackDef[]>([]);
  const [role, setRole] = useState<Role>("player");
  const [carId, setCarId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [connection, setConnection] = useState<RoomConnectionStatus>("connecting");
  const [presenceSynced, setPresenceSynced] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [starting, setStarting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleRef = useRef<RoomHandle | null>(null);
  const activeSessionIdsRef = useRef<Set<string>>(new Set());
  const settingsMutationRef = useRef(false);
  const startingRef = useRef(false);
  const resettingRef = useRef(false);
  const roomRef = useRef(room);
  const settings = room.settings;
  const sessionId = useMemo(
    () => (deviceId ? createPresenceSessionId(deviceId) : ""),
    [deviceId],
  );
  const collapsedMembers = useMemo(() => collapsePresence(members), [members]);
  const canonicalSelf = collapsedMembers.find((member) => member.deviceId === deviceId);
  const isPrimarySession = canonicalSelf?.sessionId === sessionId;
  const hasOtherPrimarySession =
    presenceSynced && canonicalSelf !== undefined && !isPrimarySession;
  const ownsRoom = deviceId !== "" && deviceId === ownerDeviceId;
  const isOwner = ownsRoom && isPrimarySession;
  const supported = hasBrowserSupabase();
  const carName = useMemo(() => cars.find((c) => c.id === carId)?.name ?? null, [cars, carId]);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  // Load this device's cars; default the pick to the active car.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<{ cars: Car[] }>("/api/cars");
        if (cancelled) return;
        setCars(res.cars);
        const active = window.localStorage.getItem(ACTIVE_CAR_KEY);
        const initial = res.cars.find((c) => c.id === active) ?? res.cars[0];
        if (initial) setCarId(initial.id);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

  // The map library contains bundled official tracks plus admin-uploaded tracks.
  useEffect(() => {
    let cancelled = false;
    fetchMaps()
      .then((list) => {
        if (!cancelled) setMaps(list);
      })
      .catch(() => {
        /* leave the picker empty; the host is told there are no maps */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Share URL + QR (setState after an await, so it's not a synchronous effect update).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = `${window.location.origin}/r/${code}`;
      const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 }).catch(() => null);
      if (cancelled) return;
      setJoinUrl(url);
      if (dataUrl) setQr(dataUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const myMeta: PresenceMeta = useMemo(
    () => ({
      deviceId,
      sessionId,
      username,
      role,
      carId,
      carName,
      ready: isReady,
    }),
    [deviceId, sessionId, username, role, carId, carName, isReady],
  );

  // Render and validate this device from local state immediately instead of
  // waiting for its presence update to make a round trip through Realtime.
  const visibleMembers = useMemo(() => {
    if (!deviceId) return collapsedMembers;
    let includesSelf = false;
    const next = collapsedMembers.map((member) => {
      if (member.deviceId !== deviceId) return member;
      includesSelf = true;
      return member.sessionId === sessionId ? myMeta : member;
    });
    if (!includesSelf && ready) next.push(myMeta);
    return next;
  }, [collapsedMembers, deviceId, myMeta, ready, sessionId]);

  const enterCanonicalRace = useCallback(
    (nextRoom: PublicRoom) => {
      if (nextRoom.status !== "racing" || !nextRoom.race) return false;
      saveRaceHandoff(code, {
        raceId: nextRoom.race.raceId,
        trackId: nextRoom.race.trackId,
        laps: nextRoom.race.laps,
        grid: nextRoom.race.grid,
        ownerDeviceId: nextRoom.ownerDeviceId,
        startAt: nextRoom.race.startAt,
      });
      router.push(`/r/${code}/race`);
      return true;
    },
    [code, router],
  );

  const refreshRoom = useCallback(async () => {
    const { room: canonical } = await apiGet<{ room: PublicRoom; serverNow: number }>(
      `/api/rooms/${code}`,
    );
    setRoom(canonical);
    if (autoJoin) enterCanonicalRace(canonical);
    return canonical;
  }, [autoJoin, code, enterCanonicalRace]);

  // A missed Realtime invalidation must not strand a player in the lobby. The database
  // snapshot is canonical, so a lightweight poll also repairs reconnects and cold loads.
  useEffect(() => {
    if (autoJoin && enterCanonicalRace(initialRoom)) return;
    const timer = window.setInterval(() => {
      void refreshRoom().catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [autoJoin, enterCanonicalRace, initialRoom, refreshRoom]);

  // Join the room channel once identity is ready (re-join only on identity/code change).
  useEffect(() => {
    if (!ready || !supported || !deviceId) return;
    const handle = joinRoom(
      code,
      {
        deviceId,
        sessionId,
        username,
        role,
        carId,
        carName,
        ready: isReady,
      },
      {
        // Presence owns membership. Replacing the roster also drops stale state from a
        // closed duplicate tab; the subsequent track/player_state carries the latest UI.
        onPresence: (incoming) => {
          activeSessionIdsRef.current = new Set(incoming.map((member) => member.sessionId));
          setMembers(incoming);
          setPresenceSynced(true);
        },
        onMessage: (msg: RoomMessage) => {
          if (msg.kind === "room_changed") {
            if (msg.version !== roomRef.current.version) void refreshRoom().catch(() => {});
          } else if (msg.kind === "player_state") {
            if (!activeSessionIdsRef.current.has(msg.member.sessionId)) return;
            setMembers((current) => {
              const index = current.findIndex(
                (member) => member.sessionId === msg.member.sessionId,
              );
              if (index < 0) return [...current, msg.member];
              const next = [...current];
              next[index] = msg.member;
              return next;
            });
          }
        },
        onStatus: (status) => {
          setConnection(status);
          if (status !== "connected") setPresenceSynced(false);
        },
      },
    );
    handleRef.current = handle;
    return () => {
      handle.leave();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, supported, deviceId, sessionId, code, refreshRoom]);

  // Push presence whenever my choices change.
  useEffect(() => {
    handleRef.current?.updatePresence(myMeta);
  }, [myMeta]);

  // The host is the only client that can see the roster, and the server needs it to advertise
  // this room on /rooms. Reported on a timer as well as on change, because the browser ages a
  // room out when its host goes quiet — that is how an abandoned lobby disappears.
  useEffect(() => {
    if (!isOwner || room.status !== "lobby") return;
    let cancelled = false;
    const report = () => {
      if (cancelled) return;
      void apiPost(`/api/rooms/${code}/occupancy`, {
        players: visibleMembers.length,
      }).catch(() => {});
    };
    report();
    const id = setInterval(report, OCCUPANCY_REPORT_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [code, isOwner, room.status, visibleMembers.length]);

  // Persist the chosen role so the race page knows whether to spectate.
  useEffect(() => {
    window.localStorage.setItem("dmc_role", role);
  }, [role]);

  const applySettings = useCallback(
    async (patch: Partial<RaceSettings>) => {
      if (
        !isOwner ||
        !presenceSynced ||
        roomRef.current.status !== "lobby" ||
        settingsMutationRef.current ||
        startingRef.current ||
        resettingRef.current
      ) {
        return;
      }
      settingsMutationRef.current = true;
      setSavingSettings(true);
      setErrorMessage(null);
      const current = roomRef.current;
      const next = { ...current.settings, ...patch };
      try {
        const { room: updated } = await apiPatch<{ room: PublicRoom }>(`/api/rooms/${code}`, {
          settings: next,
          expectedVersion: current.version,
        });
        setRoom(updated);
        await handleRef.current
          ?.send({ kind: "room_changed", version: updated.version })
          .catch(() => {});
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "설정을 저장하지 못했습니다");
        await refreshRoom().catch(() => null);
      } finally {
        settingsMutationRef.current = false;
        setSavingSettings(false);
      }
    },
    [code, isOwner, presenceSynced, refreshRoom],
  );

  const pickCar = useCallback((id: string) => {
    setCarId(id);
    setIsReady(false);
    window.localStorage.setItem(ACTIVE_CAR_KEY, id);
  }, []);

  const switchRole = useCallback((next: Role) => {
    setRole(next);
    if (next === "spectator") setIsReady(false);
  }, []);

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(joinUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [joinUrl]);

  const players = visibleMembers.filter((m) => m.role === "player");
  const readyCount = players.filter((p) => p.ready).length;
  const selectedMap = maps.find((m) => m.id === settings.trackId) ?? null;
  // A player without a car races the placeholder rig, so only the ready check gates the start.
  const withinPlayerLimit = players.length <= settings.maxPlayers;
  const canStart =
    isOwner &&
    presenceSynced &&
    room.status === "lobby" &&
    connection === "connected" &&
    !savingSettings &&
    !starting &&
    !resetting &&
    players.length >= 1 &&
    withinPlayerLimit &&
    players.every((p) => p.ready) &&
    maps.length > 0;

  const startRace = async () => {
    if (
      !canStart ||
      startingRef.current ||
      settingsMutationRef.current ||
      resettingRef.current
    ) {
      return;
    }
    startingRef.current = true;
    setStarting(true);
    setErrorMessage(null);
    try {
      await handleRef.current?.waitUntilReady();
      const current = roomRef.current;
      const { room: updated } = await apiPost<{ room: PublicRoom; serverNow: number }>(
        `/api/rooms/${code}/start`,
        {
          expectedVersion: current.version,
          playerDeviceIds: players.map((player) => player.deviceId),
        },
      );
      setRoom(updated);
      await handleRef.current
        ?.send({ kind: "room_changed", version: updated.version })
        .catch(() => {});
      if (isTouchDevice()) await enterFullscreen();
      enterCanonicalRace(updated);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "레이스를 시작하지 못했습니다");
      await refreshRoom().catch(() => null);
      startingRef.current = false;
      setStarting(false);
    }
  };

  const resetRace = async () => {
    const current = roomRef.current;
    if (
      !isOwner ||
      !presenceSynced ||
      connection !== "connected" ||
      current.status === "lobby" ||
      !current.race ||
      resettingRef.current ||
      startingRef.current ||
      settingsMutationRef.current
    ) {
      return;
    }
    resettingRef.current = true;
    setResetting(true);
    setErrorMessage(null);
    try {
      const { room: updated } = await apiPost<{ room: PublicRoom; serverNow: number }>(
        `/api/rooms/${code}/reset`,
        { expectedVersion: current.version, raceId: current.race.raceId },
      );
      setRoom(updated);
      setIsReady(false);
      await handleRef.current
        ?.send({ kind: "room_changed", version: updated.version })
        .catch(() => {});
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "대기실을 다시 열지 못했습니다");
      await refreshRoom().catch(() => null);
    } finally {
      resettingRef.current = false;
      setResetting(false);
    }
  };

  if (!supported) {
    return (
      <main className="game-bg flex h-dvh items-center justify-center text-white">
        이 빌드에는 멀티플레이가 설정되어 있지 않습니다.
      </main>
    );
  }

  return (
    <main className="lobby-page game-bg min-h-dvh w-full text-white">
      <div className="lobby-shell mx-auto flex max-w-5xl flex-col gap-6 px-5 py-6">
        {/* Header */}
        <header className="lobby-header flex items-center justify-between">
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-amber-400">
              대기실
            </div>
            <div className="flex items-baseline gap-3">
              <h1 className="text-3xl font-bold tracking-widest">{code.toUpperCase()}</h1>
              <span className="text-sm text-[#d9c193]/70">{visibleMembers.length}명 접속</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copyLink}
              className="btn-race touch-target whitespace-nowrap px-4 py-2 text-sm"
            >
              {copied ? "복사했습니다!" : "초대 링크 복사"}
            </button>
            {qr && (
              <button
                type="button"
                onClick={() => setQrOpen((open) => !open)}
                aria-label="QR 코드"
                className="btn-ghost touch-target px-3 py-2 text-base"
              >
                &#9638;
              </button>
            )}
            <Link
              href="/"
              className="touch-target flex items-center whitespace-nowrap rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/10"
            >
              &larr; 차고
            </Link>
          </div>
        </header>

        {(errorMessage ||
          connection !== "connected" ||
          !presenceSynced ||
          !withinPlayerLimit ||
          hasOtherPrimarySession) && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
            {errorMessage ??
              (hasOtherPrimarySession
                ? "같은 기기의 다른 탭이 이 플레이어의 활성 세션입니다."
                : !withinPlayerLimit
                ? `참가자는 최대 ${settings.maxPlayers}명입니다. 초과 인원은 관전으로 전환해 주세요.`
                : connection === "error"
                  ? "실시간 연결에 실패했습니다. 다시 연결하는 중입니다."
                  : "실시간 서버에 연결하는 중…")}
          </div>
        )}

        {qr && qrOpen && (
          <button
            type="button"
            onClick={() => setQrOpen(false)}
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-6"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="스캔해서 참가" className="w-56 max-w-[60vw] rounded-xl bg-white p-2" />
          </button>
        )}

        <div className="lobby-main-grid grid gap-4 md:grid-cols-[0.9fr_1.1fr]">
          {/* Roster — ready state is the thing a host scans for, so it drives the card. */}
          <section className="lobby-roster game-panel rounded-2xl p-5">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#d9c193]/70">
                참가자
              </h2>
              <span className="font-mono text-xs text-[#d9c193]/50">
                {readyCount}/{players.length} 준비
              </span>
            </div>
            {visibleMembers.length === 0 ? (
              <p className="text-sm text-[#d9c193]/50">참가자를 기다리는 중…</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {visibleMembers.map((m) => (
                  <PlayerCard
                    key={m.deviceId}
                    member={m}
                    isHost={m.deviceId === ownerDeviceId}
                    isSelf={m.deviceId === deviceId}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Race settings — everyone sees the config; only the host can change it, because
              "what am I about to race?" matters to every player in the room. */}
          <section className="lobby-settings game-panel rounded-2xl p-5">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#d9c193]/70">
                레이스 설정
              </h2>
              {!isOwner && (
                <span className="font-mono text-[10px] text-[#d9c193]/40">방장이 설정합니다</span>
              )}
            </div>

            {/* Preview on the left, every control stacked on the right: on a landscape phone
              this panel only gets ~130px of height, so nothing can afford its own row. */}
          <div className="lobby-settings-body grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <MapSummary
              map={selectedMap}
              random={settings.trackId === RANDOM_TRACK_ID}
              laps={settings.laps}
            />
            <div className="flex flex-col gap-2.5">
              <div>
                <div className="mb-1.5 text-xs text-[#d9c193]/70">맵</div>
                {maps.length === 0 ? (
                  <p className="text-sm text-amber-300/80">
                    아직 등록된 맵이 없습니다 — 관리자가 맵 제작실에서 맵을 추가해야
                    레이스를 시작할 수 있습니다.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    <Chip
                      active={settings.trackId === RANDOM_TRACK_ID}
                      disabled={
                        !isOwner ||
                        !presenceSynced ||
                        room.status !== "lobby" ||
                        savingSettings ||
                        starting ||
                        resetting
                      }
                      onClick={() => void applySettings({ trackId: RANDOM_TRACK_ID })}
                    >
                      🎲 무작위
                    </Chip>
                    {maps.map((m) => (
                      <Chip
                        key={m.id}
                        active={settings.trackId === m.id}
                        disabled={
                          !isOwner ||
                          !presenceSynced ||
                          room.status !== "lobby" ||
                          savingSettings ||
                          starting ||
                          resetting
                        }
                        onClick={() => void applySettings({ trackId: m.id })}
                        title={m.blurb}
                      >
                        {m.name}{m.official ? " · 공식" : ""}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-x-5 gap-y-2.5">
                <div>
                  <div className="mb-1.5 text-xs text-[#d9c193]/70">바퀴 수</div>
                  <div className="flex gap-1.5">
                    {LAP_OPTIONS.map((n) => (
                      <Chip
                        key={n}
                        active={settings.laps === n}
                        disabled={
                          !isOwner ||
                          !presenceSynced ||
                          room.status !== "lobby" ||
                          savingSettings ||
                          starting ||
                          resetting
                        }
                        onClick={() => void applySettings({ laps: n })}
                      >
                        {n}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 text-xs text-[#d9c193]/70">최대 인원</div>
                  <div className="flex gap-1.5">
                    {MAX_PLAYER_OPTIONS.map((n) => (
                      <Chip
                        key={n}
                        active={settings.maxPlayers === n}
                        disabled={
                          !isOwner ||
                          !presenceSynced ||
                          room.status !== "lobby" ||
                          savingSettings ||
                          starting ||
                          resetting
                        }
                        onClick={() => void applySettings({ maxPlayers: n })}
                      >
                        {n}
                      </Chip>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
          </section>

        </div>

        <div className="lobby-footer flex flex-wrap items-center gap-3">
        {/* Your setup — a bar rather than a column, so the two information panels above it
            get the full width on a landscape phone. */}
        <section
          className={`lobby-setup game-panel flex min-w-0 flex-1 flex-wrap items-center gap-3 rounded-2xl p-4 ${
            hasOtherPrimarySession ? "pointer-events-none opacity-60" : ""
          }`}
        >
          <div className="flex shrink-0 gap-2">
              <RoleButton active={role === "player"} onClick={() => switchRole("player")}>
                참가
              </RoleButton>
              <RoleButton active={role === "spectator"} onClick={() => switchRole("spectator")}>
                관전
              </RoleButton>
            </div>

          {role === "player" && (
            <>
              {cars.length === 0 ? (
                <div className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                    <div className="text-sm font-medium text-white">기본 차량으로 참가합니다</div>
                    <Link
                      href="/"
                      className="touch-target -mx-1 mt-0.5 flex items-center px-1 text-xs text-amber-400 underline"
                    >
                      차고에서 내 차를 만들 수도 있어요
                    </Link>
                  </div>
              ) : (
                <div className="lobby-car-picker min-w-0 flex-1">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-white">탈 차량 선택</span>
                      {carName && (
                        <span className="truncate text-xs text-amber-300">
                          선택: {carName}
                        </span>
                      )}
                    </div>
                    <div
                      className="lobby-car-options flex snap-x snap-mandatory gap-2 overflow-x-auto pb-2"
                      role="group"
                      aria-label="탈 차량 선택"
                    >
                      {cars.map((c) => (
                        <CarPickerCard
                          key={c.id}
                          car={c}
                          selected={carId === c.id}
                          onClick={() => pickCar(c.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              <button
                type="button"
                onClick={() => setIsReady((r) => !r)}
                className={`lobby-ready touch-target shrink-0 whitespace-nowrap rounded-lg px-5 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    isReady ? "bg-amber-600 hover:bg-amber-500" : "bg-white/10 hover:bg-white/20"
                  }`}
                >
                  {isReady
                    ? `${carName ?? "기본 차량"}(으)로 준비 완료 ✓`
                    : carName
                      ? `${carName}(으)로 준비하기`
                      : "기본 차량으로 준비하기"}
                </button>
              </>
            )}
          </section>
        {/* Start / durable race reset */}
        {room.status !== "lobby" && room.race ? (
          <>
            <button
              type="button"
              onClick={() => enterCanonicalRace(room)}
              className="btn-ghost shrink-0 whitespace-nowrap px-6 py-3 text-sm"
            >
              레이스 다시 참가
            </button>
            {isOwner ? (
              <button
                type="button"
                onClick={() => void resetRace()}
                disabled={resetting || connection !== "connected"}
                className="lobby-start btn-race shrink-0 whitespace-nowrap px-8 py-3 text-base"
              >
                {resetting ? "대기실 여는 중…" : "새 레이스 준비"}
              </button>
            ) : (
              <p className="shrink-0 text-sm text-[#d9c193]/50">
                새 레이스는 방장이 대기실을 다시 연 뒤 시작할 수 있습니다.
              </p>
            )}
          </>
        ) : (
          <>
            {isOwner && (
              <button
                type="button"
                onClick={startRace}
                disabled={!canStart}
                className="lobby-start btn-race shrink-0 whitespace-nowrap px-10 py-4 text-lg"
              >
                {starting ? "레이스 준비 중…" : "레이스 시작"}
                {players.length > 0 && (
                  <span className="ml-2 font-mono text-sm opacity-70">
                    {readyCount}/{players.length}
                  </span>
                )}
              </button>
            )}
            {!isOwner && (
              <p className="shrink-0 text-sm text-[#d9c193]/50">
                방장이 시작하기를 기다리는 중…
              </p>
            )}
          </>
        )}
        </div>

      </div>
    </main>
  );
}

function RoleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`touch-target whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition ${
        active ? "bg-amber-600" : "bg-white/10 hover:bg-white/20"
      }`}
    >
      {children}
    </button>
  );
}

function CarPickerCard({
  car,
  selected,
  onClick,
}: {
  car: Car;
  selected: boolean;
  onClick: () => void;
}) {
  const name = car.name ?? "이름 없음";
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${name}${selected ? ", 선택됨" : ""}`}
      onClick={onClick}
      className={`lobby-car-card relative w-28 shrink-0 snap-start overflow-hidden rounded-xl border text-left transition ${
        selected
          ? "border-amber-300 bg-amber-500/20 ring-2 ring-amber-400/35"
          : "border-white/15 bg-black/25 hover:border-white/40 hover:bg-white/10"
      }`}
    >
      {car.renderUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={car.renderUrl} alt="" className="h-16 w-full object-cover" />
      ) : (
        <span className="flex h-16 items-center justify-center bg-white/5 font-heading text-2xl font-bold text-white/60">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      {selected && (
        <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-amber-300 text-xs font-medium text-amber-950 shadow">
          ✓
        </span>
      )}
      <span className="block truncate px-2 py-1.5 text-xs font-medium">{name}</span>
    </button>
  );
}

function Chip({
  active,
  onClick,
  title,
  disabled = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  /** Non-hosts read the settings but cannot change them. */
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`touch-target whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm transition disabled:cursor-default ${
        active
          ? "border-amber-400 bg-amber-500/20"
          : `border-white/15 ${disabled ? "opacity-40" : "hover:bg-white/10"}`
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One racer, as a card. The ready state drives the whole card rather than a dot, so a host
 * scanning the grid sees who is holding the start up without reading any text.
 */
function PlayerCard({
  member,
  isHost,
  isSelf,
}: {
  member: PresenceMeta;
  isHost: boolean;
  isSelf: boolean;
}) {
  const spectator = member.role === "spectator";
  const ready = !spectator && member.ready;
  return (
    <li
      className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition ${
        ready
          ? "border-amber-400/60 bg-amber-400/10"
          : spectator
            ? "border-white/10 bg-black/20 opacity-70"
            : "border-white/10 bg-black/25"
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          ready ? "bg-amber-400 text-[#2a1608]" : "bg-white/10 text-white/70"
        }`}
        aria-hidden
      >
        {ready ? "✓" : member.username.trim().charAt(0).toUpperCase() || "?"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{member.username}</span>
          {isHost && (
            <span className="shrink-0 whitespace-nowrap rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-medium text-amber-300">
              방장
            </span>
          )}
          {isSelf && <span className="shrink-0 rounded bg-white/10 px-1 py-0.5 text-[9px]">나</span>}
        </span>
        <span className="block truncate text-[11px] text-[#d9c193]/60">
          {spectator
            ? "관전"
            : ready
              ? `${member.carName ?? "기본 차량"} • 준비 완료`
              : member.carName ?? "차량 고르는 중…"}
        </span>
      </span>
    </li>
  );
}

/** The course at a glance: shape, length, and how long the race will actually take. */
function MapSummary({
  map,
  random,
  laps,
}: {
  map: TrackDef | null;
  random: boolean;
  laps: number;
}) {
  if (random || !map) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/20 text-center text-xs text-[#d9c193]/50">
        {random ? "시작할 때 무작위로 정해집니다" : "맵을 선택하세요"}
      </div>
    );
  }
  const metres = lapDistance(map.gates);
  const seconds = estimateRaceSeconds(map.gates, laps);
  return (
    <div>
      <RoutePreview points={map.gates.map((gate) => gate.position)} compact accent={map.accent} />
      <div className="mt-1.5 flex flex-wrap gap-x-2 font-mono text-[10px] leading-tight text-[#d9c193]/60">
        <span className="whitespace-nowrap">{(metres / 1000).toFixed(1)}km/바퀴</span>
        <span className="whitespace-nowrap">
          예상 {Math.floor(seconds / 60)}분 {seconds % 60}초
        </span>
      </div>
    </div>
  );
}
