"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePlayer } from "@/lib/identity";
import { apiGet, apiPost } from "@/lib/api";
import { hasBrowserSupabase } from "@/lib/supabase-browser";
import { enterFullscreen, isTouchDevice, useAutoFullscreen } from "@/lib/fullscreen";
import type { Car } from "@/lib/cars";
import { CreateCarModal } from "@/components/CreateCarModal";

/**
 * Home = the garage menu, laid out like a console racing game: top HUD, a left car-info
 * panel with stats, a car-select sidebar (render thumbnails), a drag-to-spin hero
 * turntable, and a big PLAY action. Turntable is WebGL (dynamic, ssr:false).
 */
const GarageTurntable = dynamic(
  () => import("@/components/GarageTurntable").then((m) => m.GarageTurntable),
  { ssr: false, loading: () => <div className="h-full w-full" /> },
);

const ACTIVE_CAR_KEY = "dmc_active_car";

export default function Home() {
  const { username, ready, rename } = usePlayer();
  const router = useRouter();
  useAutoFullscreen();
  const [cars, setCars] = useState<Car[] | null>(null);
  const [index, setIndex] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<{ cars: Car[] }>("/api/cars");
        if (!cancelled) setCars(res.cars);
      } catch {
        if (!cancelled) setCars([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

  const count = cars?.length ?? 0;
  const selected = cars && cars.length > 0 ? cars[Math.min(index, cars.length - 1)] : null;

  useEffect(() => {
    if (selected) window.localStorage.setItem(ACTIVE_CAR_KEY, selected.id);
  }, [selected]);

  const onCreated = useCallback((car: Car) => {
    setCars((prev) => {
      const next = [...(prev ?? []), car];
      setIndex(next.length - 1);
      return next;
    });
    setModalOpen(false);
  }, []);

  const multiplayer = hasBrowserSupabase();
  const canPlay = count > 0 && multiplayer;

  const play = useCallback(async () => {
    setCreatingRoom(true);
    if (isTouchDevice()) await enterFullscreen();
    try {
      const { room } = await apiPost<{ room: { code: string } }>("/api/rooms");
      router.push(`/r/${room.code}`);
    } catch {
      setCreatingRoom(false);
    }
  }, [router]);

  return (
    <main className="game-bg relative h-dvh w-full overflow-hidden text-white">
      <div className="absolute inset-0">
        <GarageTurntable glbUrl={selected?.glbUrl ?? null} />
      </div>

      {/* Legibility vignettes */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/80 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/90 via-black/45 to-transparent" />

      {/* Top HUD */}
      <header className="safe-t safe-x absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3">
        <div>
          <div className="neon-title text-2xl leading-none sm:text-3xl">
            DRAW<span className="not-italic text-cyan-300"> &amp; </span>DRIVE
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.35em] text-cyan-400/70">
            Garage
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="game-panel hidden items-center gap-2 rounded-full px-4 py-2 text-sm sm:flex">
            <span className="text-cyan-300">◈</span> {count} car{count === 1 ? "" : "s"}
          </div>
          {ready && <ProfileChip username={username} onEdit={() => setEditingName(true)} />}
        </div>
      </header>

      {/* Empty state */}
      {cars !== null && count === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
          <div className="game-panel dmc-rise flex max-w-sm flex-col items-center gap-4 rounded-3xl p-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-b from-cyan-300 to-cyan-600 text-4xl font-light leading-none text-[#04131b] shadow-[0_0_30px_rgba(34,211,238,0.5)]">
              +
            </span>
            <h2 className="font-heading text-2xl font-bold uppercase tracking-wide">
              Build your first car
            </h2>
            <p className="text-sm text-white/60">
              Sketch a car and we&apos;ll turn it into a drivable 3D model.
            </p>
            <button type="button" onClick={() => setModalOpen(true)} className="btn-race mt-1 px-8 py-3.5 text-base">
              Draw a car
            </button>
          </div>
        </div>
      )}

      {/* Left car-info panel (desktop) */}
      {selected && (
        <aside className="safe-x pointer-events-none absolute left-0 top-24 z-10 hidden md:block">
          <CarInfoPanel car={selected} />
        </aside>
      )}

      {/* Car-select sidebar: right column on desktop, bottom strip on mobile */}
      {cars !== null && count > 0 && (
        <div className="absolute bottom-32 inset-x-0 z-10 flex gap-2 overflow-x-auto px-4 md:inset-x-auto md:right-3 md:top-24 md:bottom-36 md:w-24 md:flex-col md:overflow-x-hidden md:overflow-y-auto md:px-0">
          {cars.map((car, i) => (
            <CarThumb key={car.id} car={car} active={i === Math.min(index, count - 1)} onClick={() => setIndex(i)} />
          ))}
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            aria-label="Add car"
            className="flex aspect-square w-20 shrink-0 items-center justify-center rounded-xl border border-dashed border-white/25 text-2xl text-white/60 transition hover:border-cyan-400/60 hover:text-white md:w-full"
          >
            +
          </button>
        </div>
      )}

      {/* Bottom action cluster */}
      {selected && (
        <div className="safe-b safe-x absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-3 pb-2">
          <div className="font-heading text-xl font-bold uppercase italic tracking-wide md:hidden">
            {selected.name ?? "Untitled"}
          </div>
          <button
            type="button"
            onClick={play}
            disabled={!canPlay || creatingRoom}
            title={
              count === 0
                ? "Create a car first"
                : multiplayer
                  ? "Create a room and invite friends"
                  : "Multiplayer needs Supabase configured"
            }
            className="btn-race w-64 max-w-[80vw] px-10 py-4 text-lg"
          >
            {creatingRoom ? (
              "Creating…"
            ) : (
              <>
                <span aria-hidden>▶</span> Play
              </>
            )}
            {!multiplayer && (
              <span className="absolute -right-2 -top-2 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold not-italic text-black">
                soon
              </span>
            )}
          </button>
          <Link
            href={`/race/random?car=${selected.id}`}
            onClick={() => {
              if (isTouchDevice()) void enterFullscreen();
            }}
            className="btn-ghost px-5 py-2.5 text-sm"
          >
            Practice
          </Link>
        </div>
      )}

      {modalOpen && <CreateCarModal onClose={() => setModalOpen(false)} onCreated={onCreated} />}
      {editingName && (
        <NicknameModal
          current={username}
          onCancel={() => setEditingName(false)}
          onSave={(name) => {
            rename(name);
            setEditingName(false);
          }}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function ProfileChip({ username, onEdit }: { username: string; onEdit: () => void }) {
  const initial = username.trim().charAt(0).toUpperCase() || "?";
  return (
    <button
      type="button"
      onClick={onEdit}
      className="game-panel flex items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-3 transition hover:border-cyan-400/50"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-b from-cyan-300 to-cyan-600 font-heading text-sm font-bold text-[#04131b]">
        {initial}
      </span>
      <span className="max-w-[8rem] truncate text-sm font-medium">{username}</span>
      <span className="text-xs text-white/40" aria-hidden>
        ✎
      </span>
    </button>
  );
}

function CarThumb({ car, active, onClick }: { car: Car; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={car.name ?? "car"}
      className={`aspect-square w-20 shrink-0 overflow-hidden rounded-xl border bg-black/40 transition md:w-full ${
        active ? "border-cyan-400 ring-2 ring-cyan-400/40" : "border-white/15 hover:border-white/40"
      }`}
    >
      {car.renderUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={car.renderUrl} alt={car.name ?? "car"} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-heading text-lg font-bold text-white/70">
          {(car.name ?? "?").charAt(0).toUpperCase()}
        </span>
      )}
    </button>
  );
}

function CarInfoPanel({ car }: { car: Car }) {
  const s = carStats(car.id);
  return (
    <div className="game-panel w-72 rounded-2xl p-5">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-400/70">
        Custom build
      </div>
      <h2 className="font-heading text-2xl font-bold uppercase italic leading-tight tracking-wide">
        {car.name ?? "Untitled"}
      </h2>
      <div className="mt-4">
        <StatBar label="Top speed" value={`${s.topSpeed} km/h`} pct={s.bars.topSpeed} />
        <StatBar label="Acceleration" value={`${s.accel.toFixed(2)} s`} pct={s.bars.accel} />
        <StatBar label="Handling" value={`${s.handling.toFixed(2)} G`} pct={s.bars.handling} />
      </div>
    </div>
  );
}

function StatBar({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="flex justify-between text-[11px] uppercase tracking-wide">
        <span className="text-white/55">{label}</span>
        <span className="font-medium text-white/90">{value}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-cyan-600"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function NicknameModal({
  current,
  onCancel,
  onSave,
}: {
  current: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  const trimmed = name.trim();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="game-panel dmc-rise w-full max-w-sm rounded-2xl p-6">
        <h2 className="font-heading text-xl font-bold uppercase tracking-wide">Driver name</h2>
        <p className="mt-1 text-sm text-white/55">This is how other racers see you.</p>
        <input
          autoFocus
          value={name}
          maxLength={20}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed) onSave(trimmed);
          }}
          className="mt-4 w-full rounded-lg border border-white/15 bg-black/40 px-4 py-2.5 text-white outline-none transition focus:border-cyan-400"
        />
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="btn-ghost px-5 py-2.5 text-sm">
            Cancel
          </button>
          <button
            type="button"
            disabled={!trimmed}
            onClick={() => onSave(trimmed)}
            className="btn-race px-6 py-2.5 text-sm"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** Deterministic, stable "spec sheet" so each car has consistent showroom stats. */
function carStats(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = (h & 0xff) / 255;
  const b = ((h >> 8) & 0xff) / 255;
  const c = ((h >> 16) & 0xff) / 255;
  return {
    topSpeed: Math.round(250 + a * 110), // 250–360 km/h
    accel: 2.2 + (1 - b) * 2.6, // 2.2–4.8 s
    handling: 1.0 + c * 1.2, // 1.0–2.2 G
    bars: {
      topSpeed: Math.round(35 + a * 63),
      accel: Math.round(35 + b * 63),
      handling: Math.round(35 + c * 63),
    },
  };
}
