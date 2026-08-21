"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { useAutoFullscreen } from "@/lib/fullscreen";
import { usePlayer } from "@/lib/identity";
import { fetchMaps } from "@/lib/mapCatalog";
import type { LapRecord } from "@/lib/leaderboard";
import { formatLap, listSoloRecords, type SoloRecord } from "@/lib/soloRecords";
import type { TrackDef } from "@/lib/tracks";

/**
 * /me — one page for a player's own times.
 *
 * Practice bests and ranked bests are shown side by side per map but never combined into one
 * number. A solo lap is timed by the client alone, so it says something about your driving
 * and nothing about where you stand; putting the two in one column would quietly imply they
 * are the same kind of claim.
 */

interface Row {
  trackId: string;
  solo: SoloRecord | null;
  ranked: LapRecord | null;
  rank: number | null;
}

export default function MePage() {
  useAutoFullscreen();
  const { deviceId, username, ready } = usePlayer();
  const [solo, setSolo] = useState<SoloRecord[] | null>(null);
  const [board, setBoard] = useState<LapRecord[]>([]);
  const [maps, setMaps] = useState<TrackDef[]>([]);

  useEffect(() => {
    const load = async () => {
      setSolo(listSoloRecords());
      try {
        setMaps(await fetchMaps());
      } catch {
        /* rows fall back to naming the map by id */
      }
      try {
        const { records } = await apiGet<{ records: LapRecord[] }>("/api/leaderboard");
        setBoard(records);
      } catch {
        /* ranked columns stay empty; practice times still render */
      }
    };
    void load();
  }, []);

  const mapName = useMemo(() => {
    const byId = new Map(maps.map((map) => [map.id, map.name]));
    return (id: string) => byId.get(id) ?? "알 수 없는 맵";
  }, [maps]);

  const rows: Row[] = useMemo(() => {
    if (!solo) return [];
    const byTrack = new Map<string, Row>();
    for (const record of solo) {
      byTrack.set(record.trackId, { trackId: record.trackId, solo: record, ranked: null, rank: null });
    }
    // Rank is per map, so it is counted within that map's slice of the board.
    const perTrack = new Map<string, LapRecord[]>();
    for (const record of board) {
      const list = perTrack.get(record.trackId) ?? [];
      list.push(record);
      perTrack.set(record.trackId, list);
    }
    for (const [trackId, records] of perTrack) {
      const index = records.findIndex((record) => record.deviceId === deviceId);
      if (index < 0) continue;
      const existing = byTrack.get(trackId);
      const ranked = records[index];
      if (existing) {
        existing.ranked = ranked;
        existing.rank = index + 1;
      } else {
        byTrack.set(trackId, { trackId, solo: null, ranked, rank: index + 1 });
      }
    }
    return [...byTrack.values()].sort((a, b) => mapName(a.trackId).localeCompare(mapName(b.trackId)));
  }, [board, deviceId, mapName, solo]);

  const bestSolo = solo && solo.length > 0 ? Math.min(...solo.map((r) => r.lapMs)) : null;

  return (
    <main className="game-bg min-h-dvh w-full text-white">
      <div className="mx-auto flex h-dvh max-w-3xl flex-col gap-4 px-5 py-5">
        <header className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-xs uppercase tracking-widest text-amber-400">내 기록</div>
            <h1 className="font-display truncate text-3xl">{ready ? username : "…"}</h1>
          </div>
          <Link
            href="/"
            className="touch-target flex items-center whitespace-nowrap rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/10"
          >
            &larr; 차고
          </Link>
        </header>

        <div className="grid grid-cols-2 gap-2">
          <Stat label="연습한 맵" value={solo ? `${solo.length}개` : "…"} />
          <Stat label="연습 최고 랩" value={bestSolo === null ? "—" : formatLap(bestSolo)} />
        </div>

        <section className="game-panel min-h-0 flex-1 overflow-y-auto rounded-2xl p-2">
          {solo === null ? (
            <p className="p-6 text-center text-sm text-[#d9c193]/60">불러오는 중…</p>
          ) : rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-sm text-[#d9c193]/70">아직 기록이 없습니다.</p>
              <p className="text-xs text-[#d9c193]/45">연습 주행을 완주하면 여기에 쌓입니다.</p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {rows.map((row) => (
                <li
                  key={row.trackId}
                  className="flex items-center gap-3 rounded-xl px-3 py-2.5 odd:bg-white/[0.03]"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {mapName(row.trackId)}
                  </span>
                  <Cell
                    label="연습"
                    value={row.solo ? formatLap(row.solo.lapMs) : "—"}
                    tone="text-[#d9c193]"
                  />
                  <Cell
                    label={row.rank ? `랭크 ${row.rank}위` : "랭크"}
                    value={row.ranked ? formatLap(row.ranked.lapMs) : "—"}
                    tone="text-amber-100"
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-center font-mono text-[11px] leading-relaxed text-[#d9c193]/45">
          연습 기록은 이 기기에만 저장되며 전체 순위에는 올라가지 않습니다.
          <br />
          전체 순위는 멀티플레이 완주 기록으로만 집계됩니다.
        </p>

        <Link href="/leaderboard" className="btn-ghost mx-auto px-6 py-2.5 text-sm">
          전체 순위 보기
        </Link>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="game-panel rounded-xl px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-[#d9c193]/50">
        {label}
      </div>
      <div className="font-display text-xl text-amber-100">{value}</div>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span className="w-20 shrink-0 text-right">
      <span className="block font-mono text-[10px] uppercase tracking-wider text-[#d9c193]/45">
        {label}
      </span>
      <span className={`block font-mono text-sm tabular-nums ${tone}`}>{value}</span>
    </span>
  );
}
