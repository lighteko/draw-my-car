"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { useAutoFullscreen } from "@/lib/fullscreen";
import { usePlayer } from "@/lib/identity";
import { fetchMaps } from "@/lib/mapCatalog";
import type { LapRecord } from "@/lib/leaderboard";
import type { TrackDef } from "@/lib/tracks";

/**
 * /leaderboard — every player's best lap, across every race the game has run.
 *
 * Ranked by a single lap rather than by race time or points, so a long race and a short one
 * compare on the same terms. Laps set on different maps are not really comparable either, so
 * the map each record was set on is always shown and the filter narrows it to one map when
 * you want a fair fight.
 */

const ALL_MAPS = "__all__";

function formatLap(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return minutes > 0
    ? `${minutes}:${pad(seconds)}.${pad(hundredths)}`
    : `${seconds}.${pad(hundredths)}`;
}

/** Only the top three get colour; past that a rank is just a number. */
const MEDALS = ["text-amber-300", "text-slate-200", "text-orange-300"];

export default function LeaderboardPage() {
  useAutoFullscreen();
  const { deviceId } = usePlayer();
  // Keyed by the filter it was fetched for, so switching maps shows the loading state without
  // an effect having to reset it first.
  const [loaded, setLoaded] = useState<{ trackId: string; records: LapRecord[] } | null>(null);
  const [maps, setMaps] = useState<TrackDef[]>([]);
  const [trackId, setTrackId] = useState<string>(ALL_MAPS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await fetchMaps();
        if (!cancelled) setMaps(list);
      } catch {
        /* the record still names its map by id */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const query = trackId === ALL_MAPS ? "" : `?trackId=${encodeURIComponent(trackId)}`;
      try {
        const { records: list } = await apiGet<{ records: LapRecord[] }>(
          `/api/leaderboard${query}`,
        );
        if (cancelled) return;
        setLoaded({ trackId, records: list });
        setError(null);
      } catch {
        if (cancelled) return;
        setLoaded({ trackId, records: [] });
        setError("순위를 불러오지 못했습니다.");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  const records = loaded?.trackId === trackId ? loaded.records : null;

  const mapName = useMemo(() => {
    const byId = new Map(maps.map((map) => [map.id, map.name]));
    return (id: string) => byId.get(id) ?? "알 수 없는 맵";
  }, [maps]);

  const myBest = records?.findIndex((record) => record.deviceId === deviceId) ?? -1;

  return (
    <main className="game-bg min-h-dvh w-full text-white">
      <div className="mx-auto flex h-dvh max-w-3xl flex-col gap-4 px-5 py-5">
        <header className="flex items-center justify-between gap-3">
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-amber-400">
              전체 순위
            </div>
            <h1 className="font-display text-3xl">베스트 랩</h1>
          </div>
          <Link
            href="/"
            className="touch-target flex items-center whitespace-nowrap rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/10"
          >
            &larr; 차고
          </Link>
        </header>

        {maps.length > 0 && (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            <FilterChip
              label="전체 맵"
              active={trackId === ALL_MAPS}
              onClick={() => setTrackId(ALL_MAPS)}
            />
            {maps.map((map) => (
              <FilterChip
                key={map.id}
                label={map.name}
                active={trackId === map.id}
                onClick={() => setTrackId(map.id)}
              />
            ))}
          </div>
        )}

        <section className="game-panel min-h-0 flex-1 overflow-y-auto rounded-2xl p-2">
          {records === null ? (
            <p className="p-6 text-center text-sm text-[#d9c193]/60">불러오는 중…</p>
          ) : records.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-sm text-[#d9c193]/70">아직 기록이 없습니다.</p>
              <p className="text-xs text-[#d9c193]/45">
                멀티플레이 레이스를 완주하면 여기에 기록이 올라갑니다.
              </p>
            </div>
          ) : (
            <ol className="flex flex-col">
              {records.map((record, index) => {
                const mine = record.deviceId === deviceId;
                return (
                  <li
                    key={`${record.trackId}:${record.deviceId}`}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${
                      mine ? "bg-amber-400/12 ring-1 ring-inset ring-amber-400/40" : ""
                    }`}
                  >
                    <span
                      className={`w-8 shrink-0 text-right font-display text-lg ${
                        MEDALS[index] ?? "text-[#d9c193]/50"
                      }`}
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {record.username}
                        {mine && <span className="ml-1.5 text-xs text-amber-300">나</span>}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-[#d9c193]/55">
                        {mapName(record.trackId)}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-base tabular-nums text-amber-100">
                      {formatLap(record.lapMs)}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {error ? (
          <p className="text-center text-sm text-red-300">{error}</p>
        ) : (
          <p className="text-center font-mono text-[11px] text-[#d9c193]/45">
            {myBest >= 0
              ? `내 최고 순위 ${myBest + 1}위`
              : "한 바퀴 중 가장 빠른 랩만 집계됩니다"}
          </p>
        )}
      </div>
    </main>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`touch-target shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs transition ${
        active
          ? "border-amber-400/70 bg-amber-400/15 text-amber-100"
          : "border-white/15 text-[#d9c193]/70 hover:bg-white/5"
      }`}
    >
      {label}
    </button>
  );
}
