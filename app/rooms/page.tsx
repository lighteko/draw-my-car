"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { enterFullscreen, isTouchDevice, useAutoFullscreen } from "@/lib/fullscreen";
import { fetchMaps, RANDOM_TRACK_ID } from "@/lib/mapCatalog";
import type { OpenRoom } from "@/lib/rooms";
import type { TrackDef } from "@/lib/tracks";
import { estimateRaceSeconds } from "@/lib/tracks";

/**
 * /rooms — the room browser.
 *
 * Dropping a player straight into whichever room the server picked was disorienting: you could
 * not tell who you were about to race, on what, or whether the room was about to fill. This
 * lists what is open and lets the player choose, with making a new room as the fallback rather
 * than the default.
 *
 * The list refreshes on a timer because a lobby's contents change without anything happening
 * on this page — someone else's room fills up while you are reading it.
 */

const REFRESH_MS = 5000;

export default function RoomsPage() {
  const router = useRouter();
  useAutoFullscreen();
  const [rooms, setRooms] = useState<OpenRoom[] | null>(null);
  const [maps, setMaps] = useState<TrackDef[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMaps()
      .then((list) => {
        if (!cancelled) setMaps(list);
      })
      .catch(() => {
        /* map names simply fall back to the id */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { rooms: open } = await apiGet<{ rooms: OpenRoom[] }>("/api/rooms/open");
        if (!cancelled) {
          setRooms(open);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setRooms([]);
          setError("방 목록을 불러오지 못했습니다.");
        }
      }
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const enter = useCallback(
    async (code: string) => {
      if (isTouchDevice()) await enterFullscreen();
      router.push(`/r/${code}`);
    },
    [router],
  );

  const createRoom = useCallback(async () => {
    setCreating(true);
    setError(null);
    if (isTouchDevice()) await enterFullscreen();
    try {
      const { room } = await apiPost<{ room: { code: string } }>("/api/rooms");
      router.push(`/r/${room.code}`);
    } catch {
      setCreating(false);
      setError("방을 만들지 못했습니다.");
    }
  }, [router]);

  const mapLabel = (trackId: string) =>
    trackId === RANDOM_TRACK_ID
      ? "무작위"
      : maps.find((map) => map.id === trackId)?.name ?? "알 수 없는 맵";

  return (
    <main className="rooms-page game-bg min-h-dvh w-full text-white">
      <div className="rooms-shell mx-auto flex h-dvh max-w-4xl flex-col gap-4 px-5 py-5">
        <header className="flex items-center justify-between gap-3">
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-amber-400">
              방 찾기
            </div>
            <h1 className="font-display text-3xl">열려 있는 방</h1>
          </div>
          <Link
            href="/"
            className="touch-target flex items-center whitespace-nowrap rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/10"
          >
            &larr; 차고
          </Link>
        </header>

        <section className="game-panel min-h-0 flex-1 overflow-y-auto rounded-2xl p-4">
          {rooms === null ? (
            <p className="p-6 text-center text-sm text-[#d9c193]/60">불러오는 중…</p>
          ) : rooms.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-sm text-[#d9c193]/70">지금 열려 있는 방이 없습니다.</p>
              <p className="text-xs text-[#d9c193]/45">
                새 방을 만들면 다른 사람들이 여기에서 찾아 들어올 수 있습니다.
              </p>
            </div>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {rooms.map((room) => (
                <li key={room.code}>
                  <button
                    type="button"
                    onClick={() => void enter(room.code)}
                    className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/25 px-3 py-3 text-left transition hover:border-amber-400/60 hover:bg-amber-400/10"
                  >
                    <span className="font-display text-xl tracking-widest text-amber-200">
                      {room.code.toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{mapLabel(room.trackId)}</span>
                      <span className="block font-mono text-[11px] text-[#d9c193]/60">
                        {room.laps}바퀴
                        {maps.length > 0 && room.trackId !== RANDOM_TRACK_ID
                          ? ` · 약 ${Math.round(
                              estimateRaceSeconds(
                                maps.find((map) => map.id === room.trackId)?.gates ?? [],
                                room.laps,
                              ) / 60,
                            )}분`
                          : ""}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 font-mono text-xs">
                      {room.players}/{room.maxPlayers}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error && <p className="text-center text-sm text-red-300">{error}</p>}

        <button
          type="button"
          onClick={() => void createRoom()}
          disabled={creating}
          className="btn-race mx-auto w-full max-w-sm px-8 py-3.5 text-base"
        >
          {creating ? "방 만드는 중…" : "새 방 만들기"}
        </button>
      </div>
    </main>
  );
}
