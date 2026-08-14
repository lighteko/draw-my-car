"use client";

import { useState } from "react";
import {
  DEFAULT_VEHICLE_TUNING,
  type VehicleTuning,
} from "@/lib/vehicleTuning";

interface Setting {
  key: keyof VehicleTuning;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
}

const SETTINGS: Setting[] = [
  {
    key: "carMass",
    label: "Car mass",
    min: 300,
    max: 1500,
    step: 25,
    format: (value) => `${Math.round(value)} kg`,
  },
  { key: "engineForce", label: "Engine", min: 1000, max: 14000, step: 100 },
  { key: "reverseForce", label: "Reverse", min: 500, max: 7000, step: 100 },
  { key: "brakeForce", label: "Brakes", min: 16, max: 192, step: 4 },
  {
    key: "topSpeed",
    label: "Top speed",
    min: 10,
    max: 60,
    step: 1,
    format: (value) => `${Math.round(value * 3.6)} km/h`,
  },
  {
    key: "maxSteer",
    label: "Steering (slow)",
    min: 0.2,
    max: 0.8,
    step: 0.01,
    format: (value) => `${Math.round((value * 180) / Math.PI)}°`,
  },
  {
    key: "highSpeedSteer",
    label: "Steering (fast)",
    min: 0.05,
    max: 0.5,
    step: 0.01,
    format: (value) => `${Math.round((value * 180) / Math.PI)}°`,
  },
  { key: "frictionSlip", label: "Forward grip", min: 1, max: 14, step: 0.25 },
  { key: "sideFriction", label: "Side grip", min: 0.5, max: 3, step: 0.05 },
  { key: "handbrakeSideFriction", label: "Drift grip", min: 0.1, max: 2, step: 0.05 },
];

export function AdminDrivePanel({
  tuning,
  onChange,
  onSave,
}: {
  tuning: VehicleTuning;
  onChange: (next: VehicleTuning) => void;
  /** Persist the current tuning onto the map being tested. */
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
    <div className="absolute right-4 top-4 z-20 w-[min(18rem,calc(100vw-2rem))] text-white">
      <div className="game-panel overflow-hidden rounded-xl">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span>
            <span className="block font-mono text-[9px] uppercase tracking-[0.25em] text-cyan-300/65">
              Admin run
            </span>
            <span className="font-heading text-sm font-bold uppercase tracking-wide">
              Vehicle tuning
            </span>
          </span>
          <span className="text-sm text-white/45" aria-hidden>{open ? "−" : "+"}</span>
        </button>

        {open && (
          <div className="border-t border-white/10 px-4 pb-4 pt-3">
            <div className="space-y-3">
              {SETTINGS.map((setting) => {
                const value = tuning[setting.key];
                return (
                  <label key={setting.key} className="block">
                    <span className="mb-1 flex items-center justify-between text-[11px]">
                      <span className="text-white/55">{setting.label}</span>
                      <span className="font-mono text-cyan-200">
                        {setting.format?.(value) ?? Number(value.toFixed(2))}
                      </span>
                    </span>
                    <input
                      type="range"
                      min={setting.min}
                      max={setting.max}
                      step={setting.step}
                      value={value}
                      onChange={(event) =>
                        onChange({ ...tuning, [setting.key]: Number(event.target.value) })
                      }
                      className="h-1.5 w-full cursor-pointer accent-cyan-400"
                    />
                  </label>
                );
              })}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => onChange({ ...DEFAULT_VEHICLE_TUNING })}
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-heading text-[10px] font-semibold uppercase tracking-wider text-white/65 transition hover:border-cyan-400/40 hover:text-white"
              >
                Reset defaults
              </button>
              {onSave && (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saveState === "saving"}
                  className="flex-1 rounded-lg border border-cyan-400/30 bg-cyan-500/15 px-3 py-2 font-heading text-[10px] font-semibold uppercase tracking-wider text-cyan-200 transition hover:border-cyan-400/60 hover:text-white disabled:opacity-60"
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
