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

type Phase = "waiting" | "countdown" | "racing" | "finished";

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
  goFlash = false,
  lap,
  totalLaps,
  startAt,
  running,
  lapTimes,
  result,
  standings = [],
  selfDeviceId,
  spectator = false,
  freeDrive = false,
  wrongWay = false,
  resetNotice = false,
  muted = false,
  onToggleMuted,
  exitLabel = "완료",
  onExit,
}: {
  phase: Phase;
  countdown: number;
  /** Briefly true right after the start, to flash "GO!". */
  goFlash?: boolean;
  lap: number;
  totalLaps: number;
  startAt: number | null;
  running: boolean;
  lapTimes: number[];
  result: RaceResult | null;
  standings?: Standing[];
  selfDeviceId?: string;
  spectator?: boolean;
  /** Free-drive maps have no checkpoints, laps, or results. */
  freeDrive?: boolean;
  /** True while the car is driving away from its next gate. */
  wrongWay?: boolean;
  /** True for a moment after the wrong-way reset put the car back on a gate. */
  resetNotice?: boolean;
  muted?: boolean;
  onToggleMuted?: () => void;
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
  // Position is the one readout, alongside speed, that racing HUDs never leave out. It only
  // means anything with someone to be ahead of, so it stays hidden in a solo run.
  const rank =
    standings.length > 1 && selfDeviceId
      ? standings.findIndex((s) => s.deviceId === selfDeviceId) + 1
      : 0;

  return (
    <>
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          className="race-exit absolute left-4 top-4 z-10 rounded-md bg-black/45 px-3 py-1.5 font-mono text-xs text-white backdrop-blur transition hover:bg-black/65"
        >
          ← 나가기
        </button>
      )}

      {onToggleMuted && (
        <button
          type="button"
          onClick={onToggleMuted}
          aria-pressed={muted}
          aria-label={muted ? "소리 켜기" : "소리 끄기"}
          className="race-mute absolute left-4 top-14 z-10 rounded-md bg-black/45 px-2.5 py-1.5 font-mono text-xs text-white backdrop-blur transition hover:bg-black/65"
        >
          {muted ? "🔇" : "🔊"}
        </button>
      )}

      {spectator && (
        <div className="race-spectator pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-black/45 px-4 py-1.5 font-mono text-xs text-white backdrop-blur">
          관전 중
        </div>
      )}

      {/* Lap + timer */}
      {!spectator && !freeDrive && (phase === "racing" || phase === "finished") && (
        <div className="race-metrics pointer-events-none absolute right-4 top-4 z-10 flex flex-col items-end gap-1 font-mono text-white">
          {rank > 0 && (
            <div className="flex items-baseline gap-1 rounded-md bg-black/55 px-3 py-1 backdrop-blur">
              <span className="text-2xl font-bold leading-none text-amber-300">{rank}</span>
              <span className="text-xs text-white/60">/ {standings.length}위</span>
            </div>
          )}
          <div className="rounded-md bg-black/45 px-3 py-1.5 text-sm backdrop-blur">
            {Math.min(lap + (phase === "finished" ? 0 : 1), totalLaps)} / {totalLaps} 바퀴
          </div>
          <div className="rounded-md bg-black/45 px-3 py-1.5 text-lg font-bold backdrop-blur">
            {formatMs(elapsed)}
          </div>
          {lastLap != null && (
            <div className="rounded-md bg-black/35 px-3 py-1 text-xs backdrop-blur">
              직전 {formatMs(lastLap)}
            </div>
          )}
        </div>
      )}

      {/* Leaderboard (multiplayer) */}
      {standings.length > 1 && (phase === "racing" || phase === "finished") && (
        <div className="race-standings pointer-events-none absolute left-4 top-16 z-10 w-56 rounded-lg bg-black/45 p-2 font-mono text-xs text-white backdrop-blur">
          <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-[#d9c193]/70">
            순위
          </div>
          <ol className="flex flex-col gap-0.5">
            {standings.map((s, i) => (
              <li
                key={s.deviceId}
                className={`flex items-center gap-2 rounded px-1 py-0.5 ${
                  s.deviceId === selfDeviceId ? "bg-emerald-500/25" : ""
                }`}
              >
                <span className="w-4 text-right text-[#d9c193]/70">{i + 1}</span>
                <span className="flex-1 truncate">{s.username}</span>
                <span className="text-[#d9c193]/70">
                  {s.finished ? "🏁" : `L${Math.min(s.lap + 1, totalLaps)}`}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Wrong way */}
      {!spectator && phase === "racing" && wrongWay && (
        <div className="race-wrongway pointer-events-none absolute left-1/2 top-[22%] z-10 -translate-x-1/2">
          <div className="animate-pulse rounded-lg bg-red-600/85 px-5 py-2 text-2xl font-black tracking-wider text-white shadow-lg">
            역주행!
          </div>
        </div>
      )}

      {/* Waiting for the shared start */}
      {phase === "waiting" && (
        <div className="race-waiting pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="animate-pulse rounded-full bg-black/45 px-6 py-3 font-mono text-sm text-white backdrop-blur">
            참가자를 기다리는 중…
          </div>
        </div>
      )}

      {/* Reset notice — an unexplained teleport reads as a bug. */}
      {resetNotice && (
        <div className="race-reset pointer-events-none absolute left-1/2 top-[32%] z-10 -translate-x-1/2">
          <div className="dmc-rise rounded-lg bg-black/70 px-4 py-2 font-mono text-sm text-amber-200 backdrop-blur">
            마지막 체크포인트로 되돌렸습니다
          </div>
        </div>
      )}

      {/* Countdown + GO! flash */}
      {(phase === "countdown" || goFlash) && (
        <div className="race-countdown pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="text-8xl font-black text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.6)]">
            {phase === "countdown" && countdown > 0 ? countdown : "출발!"}
          </div>
        </div>
      )}

      {/* Controls, taught once while the lights are still red and never again. */}
      {!spectator && phase === "countdown" && (
        <div className="race-help pointer-events-none absolute bottom-24 left-1/2 z-10 -translate-x-1/2 px-4">
          <div className="rounded-xl bg-black/55 px-4 py-2.5 text-center font-mono text-[11px] leading-relaxed text-white/85 backdrop-blur">
            <span className="hidden sm:inline">
              <Key>W</Key> 전진 · <Key>S</Key> 후진 · <Key>A</Key> <Key>D</Key> 조향 ·{" "}
              <Key>Space</Key> 드리프트 · <Key>R</Key> 리셋
            </span>
            <span className="sm:hidden">왼쪽으로 조향, 오른쪽으로 가속 · 화살표를 따라가세요</span>
          </div>
        </div>
      )}

      {/* Results */}
      {!spectator && phase === "finished" && result && (
        <div className="race-results-backdrop absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="race-results-card w-full max-w-sm rounded-2xl border border-white/10 bg-[#17110b] p-6 text-white shadow-2xl">
            <h2 className="mb-1 text-center text-2xl font-bold">완주! 🏁</h2>
            {standings.length > 1 && selfDeviceId && (
              <div className="mb-2 text-center text-lg font-semibold text-amber-300">
                {standings.length}명 중 {Math.max(1, standings.findIndex((s) => s.deviceId === selfDeviceId) + 1)}위
              </div>
            )}
            <div className="mb-4 text-center font-mono text-3xl font-black text-emerald-400">
              {formatMs(result.totalMs)}
            </div>
            <ul className="race-results-laps mb-5 flex flex-col gap-1 font-mono text-sm">
              {result.lapTimes.map((t, i) => (
                <li key={i} className="flex justify-between text-neutral-300">
                  <span>{i + 1}바퀴</span>
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

/** A keycap, so the countdown hint reads as keys rather than prose. */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-white/25 bg-white/10 px-1 py-0.5 text-[10px] text-white">
      {children}
    </kbd>
  );
}
