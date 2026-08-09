"use client";

import { useState } from "react";

/**
 * CheckpointPanel — admin controls for authoring a map's checkpoint loop.
 *
 * "Drop" records a checkpoint at the car's current pose (also bound to the C key); the loop
 * is enforced in order when "Enforce order" is on (crossing out of sequence teleports the car
 * back to the last correct checkpoint). "Save to map" persists the loop as the map's gates.
 */
export function CheckpointPanel({
  count,
  enforce,
  onEnforceChange,
  onDrop,
  onUndo,
  onClear,
  onSave,
}: {
  count: number;
  enforce: boolean;
  onEnforceChange: (value: boolean) => void;
  onDrop: () => void;
  onUndo: () => void;
  onClear: () => void;
  onSave?: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const handleSave = async () => {
    if (!onSave || saveState === "saving") return;
    setSaveState("saving");
    try {
      await onSave();
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
    } catch {
      setSaveState("error");
      window.setTimeout(() => setSaveState("idle"), 2500);
    }
  };

  return (
    <div className="absolute bottom-4 left-4 z-20 w-[min(15rem,calc(100vw-2rem))] text-white">
      <div className="game-panel overflow-hidden rounded-xl">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span>
            <span className="block font-mono text-[9px] uppercase tracking-[0.25em] text-cyan-300/65">
              Admin
            </span>
            <span className="font-heading text-sm font-bold uppercase tracking-wide">
              Checkpoints
            </span>
          </span>
          <span className="font-mono text-xs text-cyan-200">
            {count}
            <span className="ml-1 text-white/45" aria-hidden>
              {open ? "−" : "+"}
            </span>
          </span>
        </button>

        {open && (
          <div className="border-t border-white/10 px-4 pb-4 pt-3">
            <button
              type="button"
              onClick={onDrop}
              className="w-full rounded-lg border border-cyan-400/40 bg-cyan-500/15 px-3 py-2.5 font-heading text-xs font-bold uppercase tracking-wider text-cyan-100 transition hover:border-cyan-400/70 hover:text-white"
            >
              Drop checkpoint
              <span className="ml-1.5 font-mono text-[9px] text-cyan-300/70">[C]</span>
            </button>

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={onUndo}
                disabled={count === 0}
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-heading text-[10px] font-semibold uppercase tracking-wider text-white/65 transition hover:border-white/25 hover:text-white disabled:opacity-40"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={onClear}
                disabled={count === 0}
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-heading text-[10px] font-semibold uppercase tracking-wider text-white/65 transition hover:border-red-400/40 hover:text-red-300 disabled:opacity-40"
              >
                Clear
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
              <span>Enforce order</span>
              <span className="font-mono text-[10px]">{enforce ? "ON" : "OFF"}</span>
            </button>

            {onSave && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saveState === "saving"}
                className="mt-3 w-full rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 font-heading text-[10px] font-semibold uppercase tracking-wider text-cyan-200 transition hover:border-cyan-400/60 hover:text-white disabled:opacity-60"
              >
                {saveState === "saving"
                  ? "Saving…"
                  : saveState === "saved"
                    ? "Saved ✓"
                    : saveState === "error"
                      ? "Save failed"
                      : "Save to map"}
              </button>
            )}
            <p className="mt-2 text-[9px] leading-tight text-white/35">
              Drive through, drop points in order. Saving rebuilds the map&apos;s gate loop.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
