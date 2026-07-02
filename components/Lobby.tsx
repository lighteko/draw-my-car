"use client";

import QRCode from "qrcode";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePlayer } from "@/lib/identity";
import { hasBrowserSupabase } from "@/lib/supabase-browser";
import { joinRoom, type RoomHandle } from "@/lib/realtime";
import { apiGet, apiPatch } from "@/lib/api";
import { TRACKS, trackName, resolveTrackId } from "@/lib/tracks";
import {
  LAP_OPTIONS,
  MAX_PLAYER_OPTIONS,
  type GridSlot,
  type PresenceMeta,
  type RaceSettings,
  type Role,
  type RoomMessage,
} from "@/lib/roomTypes";
import type { Car } from "@/lib/cars";

const ACTIVE_CAR_KEY = "dmc_active_car";

/**
 * Lobby — presence roster + owner race settings + share (link/QR), all over one Realtime
 * channel. The owner is the only one who can edit settings; changes broadcast live and are
 * persisted so a share-link cold load sees the current config. Starting the race is wired
 * in the race phase (the button is present but inert here).
 */
export function Lobby({
  code,
  ownerDeviceId,
  initialSettings,
}: {
  code: string;
  ownerDeviceId: string;
  initialSettings: RaceSettings;
}) {
  const { deviceId, username, ready } = usePlayer();
  const router = useRouter();

  const [settings, setSettings] = useState<RaceSettings>(initialSettings);
  const [members, setMembers] = useState<PresenceMeta[]>([]);
  const [cars, setCars] = useState<Car[]>([]);
  const [role, setRole] = useState<Role>("player");
  const [carId, setCarId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const handleRef = useRef<RoomHandle | null>(null);
  const isOwner = deviceId !== "" && deviceId === ownerDeviceId;
  const supported = hasBrowserSupabase();
  const carName = useMemo(() => cars.find((c) => c.id === carId)?.name ?? null, [cars, carId]);

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
    () => ({ deviceId, username, role, carId, carName, ready: isReady }),
    [deviceId, username, role, carId, carName, isReady],
  );

  // Join the room channel once identity is ready (re-join only on identity/code change).
  useEffect(() => {
    if (!ready || !supported || !deviceId) return;
    const handle = joinRoom(
      code,
      { deviceId, username, role, carId, carName, ready: isReady },
      {
        onPresence: setMembers,
        onMessage: (msg: RoomMessage) => {
          if (msg.kind === "settings") setSettings(msg.settings);
          else if (msg.kind === "start")
            router.push(`/r/${code}/race?track=${msg.trackId}&laps=${msg.laps}`);
        },
      },
    );
    handleRef.current = handle;
    return () => {
      handle.leave();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, supported, deviceId, code]);

  // Push presence whenever my choices change.
  useEffect(() => {
    handleRef.current?.updatePresence(myMeta);
  }, [myMeta]);

  // Persist the chosen role so the race page knows whether to spectate.
  useEffect(() => {
    window.localStorage.setItem("dmc_role", role);
  }, [role]);

  const applySettings = useCallback(
    (next: RaceSettings) => {
      setSettings(next);
      handleRef.current?.send({ kind: "settings", settings: next });
      apiPatch(`/api/rooms/${code}`, { settings: next }).catch(() => {});
    },
    [code],
  );

  const pickCar = useCallback((id: string) => {
    setCarId(id);
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

  const players = members.filter((m) => m.role === "player");
  const canStart = players.length >= 1 && players.every((p) => p.ready && p.carId);

  const startRace = async () => {
    const resolved = resolveTrackId(settings.trackId);
    const grid: GridSlot[] = players.map((p, i) => ({ deviceId: p.deviceId, slot: i }));
    // Await the broadcast so it flushes before we navigate away (which closes the channel).
    await handleRef.current?.send({
      kind: "start",
      trackId: resolved,
      laps: settings.laps,
      grid,
      startAt: Date.now() + 1000,
    });
    apiPatch(`/api/rooms/${code}`, { status: "racing" }).catch(() => {});
    router.push(`/r/${code}/race?track=${resolved}&laps=${settings.laps}`);
  };

  if (!supported) {
    return (
      <main className="game-bg flex h-dvh items-center justify-center text-white">
        Multiplayer isn&apos;t configured in this build.
      </main>
    );
  }

  return (
    <main className="game-bg min-h-dvh w-full text-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-6">
        {/* Header */}
        <header className="flex items-center justify-between">
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-cyan-400">
              Race lobby
            </div>
            <div className="flex items-baseline gap-3">
              <h1 className="text-3xl font-bold tracking-widest">{code.toUpperCase()}</h1>
              <span className="text-sm text-neutral-400">{members.length} in room</span>
            </div>
          </div>
          <Link href="/" className="rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/10">
            ← Garage
          </Link>
        </header>

        <div className="grid gap-6 md:grid-cols-[1fr_20rem]">
          {/* Roster */}
          <section className="game-panel rounded-2xl p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Players
            </h2>
            <ul className="flex flex-col gap-2">
              {members.length === 0 && (
                <li className="text-sm text-neutral-500">Waiting for players…</li>
              )}
              {members.map((m) => (
                <li
                  key={m.deviceId}
                  className="flex items-center gap-3 rounded-lg bg-black/30 px-3 py-2.5"
                >
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      m.role === "spectator"
                        ? "bg-neutral-500"
                        : m.ready
                          ? "bg-cyan-400"
                          : "bg-amber-400"
                    }`}
                  />
                  <span className="font-medium">{m.username}</span>
                  {m.deviceId === ownerDeviceId && (
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                      HOST
                    </span>
                  )}
                  {m.deviceId === deviceId && (
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px]">you</span>
                  )}
                  <span className="ml-auto text-xs text-neutral-400">
                    {m.role === "spectator"
                      ? "spectating"
                      : m.carName
                        ? `${m.carName}${m.ready ? " • ready" : ""}`
                        : "picking a car…"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {/* Side column */}
          <div className="flex flex-col gap-6">
            {/* Share */}
            <section className="game-panel rounded-2xl p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
                Invite
              </h2>
              {qr && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} alt="Scan to join" className="mx-auto mb-3 rounded-lg bg-white p-1" />
              )}
              <button
                type="button"
                onClick={copyLink}
                className="w-full rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold transition hover:bg-cyan-500"
              >
                {copied ? "Copied!" : "Copy invite link"}
              </button>
            </section>

            {/* Your setup */}
            <section className="game-panel rounded-2xl p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
                You
              </h2>
              <div className="mb-3 flex gap-2">
                <RoleButton active={role === "player"} onClick={() => switchRole("player")}>
                  Player
                </RoleButton>
                <RoleButton active={role === "spectator"} onClick={() => switchRole("spectator")}>
                  Spectator
                </RoleButton>
              </div>

              {role === "player" && (
                <>
                  {cars.length === 0 ? (
                    <Link href="/" className="block text-sm text-cyan-400 underline">
                      You have no cars yet — make one in the garage
                    </Link>
                  ) : (
                    <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                      {cars.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => pickCar(c.id)}
                          className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm ${
                            carId === c.id
                              ? "border-cyan-400 bg-cyan-500/20"
                              : "border-white/15 hover:bg-white/10"
                          }`}
                        >
                          {c.name ?? "Untitled"}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={!carId}
                    onClick={() => setIsReady((r) => !r)}
                    className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      isReady ? "bg-cyan-600 hover:bg-cyan-500" : "bg-white/10 hover:bg-white/20"
                    }`}
                  >
                    {isReady ? "Ready ✓" : "Ready up"}
                  </button>
                </>
              )}
            </section>
          </div>
        </div>

        {/* Owner: race settings */}
        {isOwner && (
          <section className="game-panel rounded-2xl p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Race settings
            </h2>

            <div className="mb-5">
              <div className="mb-2 text-sm text-neutral-400">Map</div>
              <div className="flex flex-wrap gap-2">
                <Chip
                  active={settings.trackId === "random"}
                  onClick={() => applySettings({ ...settings, trackId: "random" })}
                >
                  🎲 Randomize
                </Chip>
                {TRACKS.map((t) => (
                  <Chip
                    key={t.id}
                    active={settings.trackId === t.id}
                    onClick={() => applySettings({ ...settings, trackId: t.id })}
                    title={t.blurb}
                  >
                    {t.name}
                  </Chip>
                ))}
              </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <div className="mb-2 text-sm text-neutral-400">Laps</div>
                <div className="flex gap-2">
                  {LAP_OPTIONS.map((n) => (
                    <Chip
                      key={n}
                      active={settings.laps === n}
                      onClick={() => applySettings({ ...settings, laps: n })}
                    >
                      {n}
                    </Chip>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-sm text-neutral-400">Max players</div>
                <div className="flex gap-2">
                  {MAX_PLAYER_OPTIONS.map((n) => (
                    <Chip
                      key={n}
                      active={settings.maxPlayers === n}
                      onClick={() => applySettings({ ...settings, maxPlayers: n })}
                    >
                      {n}
                    </Chip>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Start */}
        {isOwner && (
          <button
            type="button"
            onClick={startRace}
            disabled={!canStart}
            className="btn-race mx-auto px-12 py-4 text-lg"
          >
            Start race
          </button>
        )}
        {!isOwner && (
          <p className="text-center text-sm text-neutral-500">
            Waiting for the host to start the race…
          </p>
        )}
        {isOwner && !canStart && (
          <p className="text-center text-xs text-neutral-500">
            Every player needs a car and a ready check before the race can start.
          </p>
        )}

        <p className="text-center text-xs text-neutral-600">
          Racing on {settings.trackId === "random" ? "a random map" : trackName(settings.trackId)} ·{" "}
          {settings.laps} lap{settings.laps > 1 ? "s" : ""}
        </p>
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
      className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
        active ? "bg-cyan-600" : "bg-white/10 hover:bg-white/20"
      }`}
    >
      {children}
    </button>
  );
}

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-lg border px-3 py-1.5 text-sm transition ${
        active ? "border-cyan-400 bg-cyan-500/20" : "border-white/15 hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}
