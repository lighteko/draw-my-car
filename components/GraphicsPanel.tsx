"use client";

import { useRef, useState } from "react";
import {
  DEFAULT_GRAPHICS_SETTINGS,
  type GraphicsSettings,
} from "@/lib/graphicsSettings";

/**
 * GraphicsPanel — admin overlay for live scene lighting + environment.
 *
 * The sun direction is set with a draggable pad (centre = overhead, edge = low on the
 * horizon; the angle is the compass bearing); the rest are sliders/toggles. All changes
 * flow straight to the scene through onChange — nothing here is persisted.
 */

const PAD = 96;
const PAD_R = PAD / 2;

interface Slider {
  key: keyof GraphicsSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
}

const SLIDERS: Slider[] = [
  { key: "sunIntensity", label: "Sun intensity", min: 0, max: 5, step: 0.05 },
  { key: "ambient", label: "Ambient", min: 0, max: 2, step: 0.05 },
  { key: "fill", label: "Sky fill", min: 0, max: 1.5, step: 0.05 },
];

const FOG_SLIDERS: Slider[] = [
  { key: "fogNear", label: "Fog start", min: 20, max: 400, step: 5, format: (v) => `${Math.round(v)} m` },
  { key: "fogFar", label: "Fog end", min: 100, max: 900, step: 10, format: (v) => `${Math.round(v)} m` },
];

// Shadow quality: raising the resolution and dialing in the bias removes the "digital"
// banding (shadow acne) on the map surfaces.
const SHADOW_SLIDERS: Slider[] = [
  {
    key: "shadowMapSize",
    label: "Resolution",
    min: 512,
    max: 4096,
    step: 512,
    format: (v) => `${Math.round(v)} px`,
  },
  {
    key: "shadowBias",
    label: "Depth bias",
    min: -0.001,
    max: 0.001,
    step: 0.00005,
    format: (v) => v.toFixed(5),
  },
  {
    key: "shadowNormalBias",
    label: "Normal bias",
    min: 0,
    max: 0.1,
    step: 0.005,
    format: (v) => v.toFixed(3),
  },
];

export function GraphicsPanel({
  settings,
  onChange,
  onSave,
}: {
  settings: GraphicsSettings;
  onChange: (next: GraphicsSettings) => void;
  /** Persist the current graphics onto the map being tested. */
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
    <div className="absolute left-4 top-16 z-20 w-[min(16rem,calc(100vw-2rem))] text-white">
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
            <span className="font-heading text-sm font-bold uppercase tracking-wide">Graphics</span>
          </span>
          <span className="text-sm text-white/45" aria-hidden>
            {open ? "−" : "+"}
          </span>
        </button>

        {open && (
          <div className="border-t border-white/10 px-4 pb-4 pt-3">
            <div className="flex gap-3">
              <SunPad settings={settings} onChange={onChange} />
              <div className="flex-1 space-y-1 self-center font-mono text-[10px] text-white/55">
                <div className="flex justify-between">
                  <span>Azimuth</span>
                  <span className="text-cyan-200">{Math.round(settings.sunAzimuth)}°</span>
                </div>
                <div className="flex justify-between">
                  <span>Elevation</span>
                  <span className="text-cyan-200">{Math.round(settings.sunElevation)}°</span>
                </div>
                <p className="pt-1 text-[9px] leading-tight text-white/35">
                  Drag the sun. Centre is overhead, edge is low.
                </p>
              </div>
            </div>

            <div className="mt-3 space-y-3">
              {SLIDERS.map((slider) => (
                <SliderRow
                  key={slider.key}
                  slider={slider}
                  value={settings[slider.key] as number}
                  onChange={(value) => onChange({ ...settings, [slider.key]: value })}
                />
              ))}
            </div>

            <div className="mt-3 flex gap-2">
              <ToggleRow
                label="Shadows"
                on={settings.shadows}
                onToggle={() => onChange({ ...settings, shadows: !settings.shadows })}
              />
              <ToggleRow
                label="Fog"
                on={settings.fog}
                onToggle={() => onChange({ ...settings, fog: !settings.fog })}
              />
            </div>

            {settings.fog && (
              <div className="mt-3 space-y-3">
                {FOG_SLIDERS.map((slider) => (
                  <SliderRow
                    key={slider.key}
                    slider={slider}
                    value={settings[slider.key] as number}
                    onChange={(value) => onChange({ ...settings, [slider.key]: value })}
                  />
                ))}
              </div>
            )}

            {settings.shadows && (
              <div className="mt-4 border-t border-white/10 pt-3">
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.2em] text-white/35">
                  Shadow quality
                </div>
                <div className="space-y-3">
                  {SHADOW_SLIDERS.map((slider) => (
                    <SliderRow
                      key={slider.key}
                      slider={slider}
                      value={settings[slider.key] as number}
                      onChange={(value) => onChange({ ...settings, [slider.key]: value })}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => onChange({ ...DEFAULT_GRAPHICS_SETTINGS })}
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

function SliderRow({
  slider,
  value,
  onChange,
}: {
  slider: Slider;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-white/55">{slider.label}</span>
        <span className="font-mono text-cyan-200">
          {slider.format?.(value) ?? Number(value.toFixed(2))}
        </span>
      </span>
      <input
        type="range"
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer accent-cyan-400"
      />
    </label>
  );
}

function ToggleRow({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={`flex flex-1 items-center justify-between rounded-lg border px-3 py-2 text-[11px] transition ${
        on
          ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-100"
          : "border-white/10 bg-white/5 text-white/50 hover:text-white"
      }`}
    >
      <span>{label}</span>
      <span className="font-mono text-[10px]">{on ? "ON" : "OFF"}</span>
    </button>
  );
}

/** Draggable sun-direction disc: angle → azimuth, distance from centre → (90 − elevation). */
function SunPad({
  settings,
  onChange,
}: {
  settings: GraphicsSettings;
  onChange: (next: GraphicsSettings) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  const az = (settings.sunAzimuth * Math.PI) / 180;
  const r = ((90 - settings.sunElevation) / 85) * PAD_R;
  const sunX = PAD_R + Math.sin(az) * r;
  const sunY = PAD_R - Math.cos(az) * r;

  const apply = (clientX: number, clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = clientX - (rect.left + PAD_R);
    const dy = clientY - (rect.top + PAD_R);
    const dist = Math.min(Math.hypot(dx, dy), PAD_R);
    let azimuth = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (azimuth < 0) azimuth += 360;
    const elevation = 90 - (dist / PAD_R) * 85;
    onChange({ ...settings, sunAzimuth: azimuth, sunElevation: elevation });
  };

  return (
    <svg
      ref={ref}
      width={PAD}
      height={PAD}
      className="shrink-0 cursor-crosshair touch-none rounded-full bg-black/40"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        apply(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (dragging.current) apply(event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <circle cx={PAD_R} cy={PAD_R} r={PAD_R - 1} fill="none" stroke="rgba(255,255,255,0.12)" />
      <circle cx={PAD_R} cy={PAD_R} r={PAD_R / 2} fill="none" stroke="rgba(255,255,255,0.08)" />
      <line x1={PAD_R} y1={2} x2={PAD_R} y2={PAD} stroke="rgba(255,255,255,0.06)" />
      <line x1={2} y1={PAD_R} x2={PAD} y2={PAD_R} stroke="rgba(255,255,255,0.06)" />
      <line
        x1={PAD_R}
        y1={PAD_R}
        x2={sunX}
        y2={sunY}
        stroke="rgba(250,204,21,0.5)"
        strokeWidth={1.5}
      />
      <circle cx={sunX} cy={sunY} r={6} fill="#facc15" stroke="rgba(0,0,0,0.5)" strokeWidth={1} />
    </svg>
  );
}
