"use client";

import { useState } from "react";

/**
 * LayoutPanel — admin controls for authoring a map's layout by driving it.
 *
 * Both tools capture the car's current pose. "Set start here" (also the G key) marks where the
 * grid is built, slot 0 landing exactly on that pose. "Drop checkpoint" (also the C key)
 * records the next gate in the loop; with "Enforce order" on, crossing out of sequence
 * teleports the car back to the last correct checkpoint. Each section saves to the map on its
 * own, so revising the route never disturbs the start line and vice versa.
 */
export function LayoutPanel({
  count,
  enforce,
  hasSpawn,
  onEnforceChange,
  onDrop,
  onUndo,
  onClear,
  onSetSpawn,
  onClearSpawn,
  onSave,
  onSaveSpawn,
}: {
  count: number;
  enforce: boolean;
  /** Whether a start pose is staged (authored this session or loaded from the map). */
  hasSpawn: boolean;
  onEnforceChange: (value: boolean) => void;
  onDrop: () => void;
  onUndo: () => void;
  onClear: () => void;
  onSetSpawn: () => void;
  onClearSpawn: () => void;
  onSave?: () => Promise<void> | void;
  onSaveSpawn?: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(true);

  const handleSave = useSaveButton(onSave);
  const handleSaveSpawn = useSaveButton(onSaveSpawn);

  return (
    <div className="absolute bottom-4 left-4 z-20 w-[min(15rem,calc(100vw-2rem))] text-white">
      <div className="game-panel overflow-hidden rounded-xl">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span>
            <span className="block font-mono text-[9px] uppercase tracking-[0.25em] text-amber-300/65">
              관리자
            </span>
            <span className="font-heading text-sm font-bold uppercase tracking-wide">
              맵 구성
            </span>
          </span>
          <span className="font-mono text-xs text-amber-200">
            {count}
            <span className="ml-1 text-white/45" aria-hidden>
              {open ? "−" : "+"}
            </span>
          </span>
        </button>

        {open && (
          <div className="border-t border-white/10 px-4 pb-4 pt-3">
            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/35">
              출발 그리드
            </div>
            <button
              type="button"
              onClick={onSetSpawn}
              className="w-full rounded-lg border border-amber-300/40 bg-amber-400/15 px-3 py-2.5 font-heading text-xs font-medium uppercase tracking-wider text-amber-100 transition hover:border-amber-300/70 hover:text-white"
            >
              {hasSpawn ? "여기로 출발점 옮기기" : "여기를 출발점으로"}
              <span className="ml-1.5 font-mono text-[9px] text-amber-200/70">[G]</span>
            </button>

            {hasSpawn && (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={onClearSpawn}
                  className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-heading text-[10px] font-medium uppercase tracking-wider text-white/65 transition hover:border-red-400/40 hover:text-red-300"
                >
                  해제
                </button>
                {onSaveSpawn && (
                  <button
                    type="button"
                    onClick={handleSaveSpawn.run}
                    disabled={handleSaveSpawn.state === "saving"}
                    className="flex-1 rounded-lg border border-amber-300/30 bg-amber-400/10 px-3 py-2 font-heading text-[10px] font-medium uppercase tracking-wider text-amber-200 transition hover:border-amber-300/60 hover:text-white disabled:opacity-60"
                  >
                    {saveLabel(handleSaveSpawn.state, "출발점 저장")}
                  </button>
                )}
              </div>
            )}
            <p className="mt-2 text-[9px] leading-tight text-white/35">
              레이스가 시작될 위치에 차를 세우고 저장하세요 — 1번 자리가 정확히 그 지점입니다.
            </p>

            <div className="my-3 border-t border-white/10" />

            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/35">
              체크포인트
            </div>
            <button
              type="button"
              onClick={onDrop}
              className="w-full rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-2.5 font-heading text-xs font-medium uppercase tracking-wider text-amber-100 transition hover:border-amber-400/70 hover:text-white"
            >
              체크포인트 찍기
              <span className="ml-1.5 font-mono text-[9px] text-amber-300/70">[C]</span>
            </button>

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={onUndo}
                disabled={count === 0}
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-heading text-[10px] font-medium uppercase tracking-wider text-white/65 transition hover:border-white/25 hover:text-white disabled:opacity-40"
              >
                되돌리기
              </button>
              <button
                type="button"
                onClick={onClear}
                disabled={count === 0}
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-heading text-[10px] font-medium uppercase tracking-wider text-white/65 transition hover:border-red-400/40 hover:text-red-300 disabled:opacity-40"
              >
                전체 삭제
              </button>
            </div>

            <button
              type="button"
              onClick={() => onEnforceChange(!enforce)}
              aria-pressed={enforce}
              disabled={count === 0}
              className={`mt-2 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-[11px] transition disabled:opacity-40 ${
                enforce
                  ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-100"
                  : "border-white/10 bg-white/5 text-white/55 hover:text-white"
              }`}
            >
              <span>순서 강제</span>
              <span className="font-mono text-[10px]">{enforce ? "켜짐" : "꺼짐"}</span>
            </button>

            {onSave && (
              <button
                type="button"
                onClick={handleSave.run}
                disabled={handleSave.state === "saving"}
                className="mt-3 w-full rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 font-heading text-[10px] font-medium uppercase tracking-wider text-amber-200 transition hover:border-amber-400/60 hover:text-white disabled:opacity-60"
              >
                {saveLabel(handleSave.state, "코스 저장")}
              </button>
            )}
            <p className="mt-2 text-[9px] leading-tight text-white/35">
              달리면서 순서대로 찍으세요. 저장하면 맵의 코스가 다시 만들어집니다.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";

/** Runs a save action and reports its outcome on the button for a moment afterwards. */
function useSaveButton(action?: () => Promise<void> | void): {
  state: SaveState;
  run: () => Promise<void>;
} {
  const [state, setState] = useState<SaveState>("idle");
  const run = async () => {
    if (!action || state === "saving") return;
    setState("saving");
    try {
      await action();
      setState("saved");
      window.setTimeout(() => setState("idle"), 1800);
    } catch {
      setState("error");
      window.setTimeout(() => setState("idle"), 2500);
    }
  };
  return { state, run };
}

function saveLabel(state: SaveState, idle: string): string {
  if (state === "saving") return "저장 중…";
  if (state === "saved") return "저장됨 ✓";
  if (state === "error") return "저장 실패";
  return idle;
}
