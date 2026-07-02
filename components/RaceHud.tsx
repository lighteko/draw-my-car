"use client";

import { useEffect, useState } from "react";
import type { Standing } from "@/lib/roomTypes";

/**
 * RaceHud — DOM overlay for the race (countdown, lap/timer, leaderboard, results).
 * Sibling of the Canvas so its per-tick re-renders never touch the WebGL tree.
 */

export interface RaceResult {
  totalMs: number;
  lapTimes: number[];
}

type Phase = "countdown" | "racing" | "finished";

export function formatMs(ms: number): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

export function RaceHud({
  phase,
  countdown,
  lap,
  totalLaps,
  startAt,
  running,
  lapTimes,
  result,
  standings = [],
  selfDeviceId,
  spectator = false,
  exitLabel = "Done",
  onExit,
}: {
  phase: Phase;
  countdown: number;
  lap: number;
  totalLaps: number;
  startAt: number | null;
  running: boolean;
  lapTimes: number[];
  result: RaceResult | null;
  standings?: Standing[];
  selfDeviceId?: string;
  spectator?: boolean;
  exitLabel?: string;
  onExit?: () => void;
}) {
  // Refresh the running clock (~12 fps is plenty for a timer readout). performance.now()
  // is read only inside the interval callback, never during render.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowMs(performance.now()), 80);
    return () => clearInterval(id);
  }, [running]);

  const elapsed =
    running && startAt != null && nowMs > 0 ? nowMs - startAt : result?.totalMs ?? 0;
  const lastLap = lapTimes.length ? lapTimes[lapTimes.length - 1] : null;

  return (
    <>
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          className="absolute left-4 top-4 z-10 rounded-md bg-black/45 px-3 py-1.5 font-mono text-xs text-white backdrop-blur transition hover:bg-black/65"
        >
          ← exit
        </button>
      )}

      {spectator && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-black/45 px-4 py-1.5 font-mono text-xs text-white backdrop-blur">
          Spectating
        </div>
      )}

      {/* Lap + timer */}
      {!spectator && phase !== "countdown" && (
        <div className="pointer-events-none absolute right-4 top-4 z-10 flex flex-col items-end gap-1 font-mono text-white">
          <div className="rounded-md bg-black/45 px-3 py-1.5 text-sm backdrop-blur">
            Lap {Math.min(lap + (phase === "finished" ? 0 : 1), totalLaps)} / {totalLaps}
          </div>
          <div className="rounded-md bg-black/45 px-3 py-1.5 text-lg font-bold backdrop-blur">
            {formatMs(elapsed)}
          </div>
          {lastLap != null && (
            <div className="rounded-md bg-black/35 px-3 py-1 text-xs backdrop-blur">
              last {formatMs(lastLap)}
            </div>
          )}
        </div>
      )}

      {/* Leaderboard (multiplayer) */}
      {standings.length > 1 && phase !== "countdown" && (
        <div className="pointer-events-none absolute left-4 top-16 z-10 w-56 rounded-lg bg-black/45 p-2 font-mono text-xs text-white backdrop-blur">
          <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-neutral-400">
            Standings
          </div>
          <ol className="flex flex-col gap-0.5">
            {standings.map((s, i) => (
              <li
                key={s.deviceId}
                className={`flex items-center gap-2 rounded px-1 py-0.5 ${
                  s.deviceId === selfDeviceId ? "bg-emerald-500/25" : ""
                }`}
              >
                <span className="w-4 text-right text-neutral-400">{i + 1}</span>
                <span className="flex-1 truncate">{s.username}</span>
                <span className="text-neutral-400">
                  {s.finished ? "🏁" : `L${Math.min(s.lap + 1, totalLaps)}`}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Countdown */}
      {phase === "countdown" && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="text-8xl font-black text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.6)]">
            {countdown > 0 ? countdown : "GO!"}
          </div>
        </div>
      )}

      {/* Results */}
      {!spectator && phase === "finished" && result && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-6 text-white shadow-2xl">
            <h2 className="mb-1 text-center text-2xl font-bold">Finished! 🏁</h2>
            {standings.length > 1 && selfDeviceId && (
              <div className="mb-2 text-center text-lg font-semibold text-amber-300">
                P{Math.max(1, standings.findIndex((s) => s.deviceId === selfDeviceId) + 1)} of{" "}
                {standings.length}
              </div>
            )}
            <div className="mb-4 text-center font-mono text-3xl font-black text-emerald-400">
              {formatMs(result.totalMs)}
            </div>
            <ul className="mb-5 flex flex-col gap-1 font-mono text-sm">
              {result.lapTimes.map((t, i) => (
                <li key={i} className="flex justify-between text-neutral-300">
                  <span>Lap {i + 1}</span>
                  <span>{formatMs(t)}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onExit}
              className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-semibold transition hover:bg-emerald-500"
            >
              {exitLabel}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
