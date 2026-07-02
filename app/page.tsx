"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePlayer } from "@/lib/identity";
import { apiGet, apiPost } from "@/lib/api";
import { hasBrowserSupabase } from "@/lib/supabase-browser";
import type { Car } from "@/lib/cars";
import { CreateCarModal } from "@/components/CreateCarModal";

/**
 * Home = the garage menu. A rotating hero car with a big PLAY action, styled like a
 * console racing game's main screen. The turntable is WebGL (dynamic, ssr:false).
 */
const GarageTurntable = dynamic(
  () => import("@/components/GarageTurntable").then((m) => m.GarageTurntable),
  { ssr: false, loading: () => <div className="h-full w-full" /> },
);

const ACTIVE_CAR_KEY = "dmc_active_car";

export default function Home() {
  const { username, ready } = usePlayer();
  const router = useRouter();
  const [cars, setCars] = useState<Car[] | null>(null);
  const [index, setIndex] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
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

  const prev = () => setIndex((i) => (i - 1 + count) % count);
  const next = () => setIndex((i) => (i + 1) % count);

  const multiplayer = hasBrowserSupabase();
  const canPlay = count > 0 && multiplayer;

  const play = useCallback(async () => {
    setCreatingRoom(true);
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
      <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-black/75 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/90 via-black/50 to-transparent" />

      {/* Top bar */}
      <header className="safe-t safe-x absolute inset-x-0 top-0 flex items-start justify-between">
        <div>
          <div className="neon-title text-3xl leading-none sm:text-4xl">
            DRAW<span className="not-italic text-cyan-300"> &amp; </span>DRIVE
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.35em] text-cyan-400/70">
            Garage
          </div>
        </div>
        {ready && <ProfileChip username={username} />}
      </header>

      {/* Empty state */}
      {cars !== null && count === 0 && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
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

      {/* Bottom menu cluster */}
      {selected && (
        <div className="safe-b safe-x absolute inset-x-0 bottom-0 flex flex-col items-center gap-5 pb-2">
          {/* Nameplate + carousel */}
          <div className="flex items-center gap-5">
            {count > 1 && <Chevron dir="left" onClick={prev} />}
            <div className="min-w-[10rem] text-center">
              <div className="font-heading text-2xl font-bold uppercase italic tracking-wide sm:text-3xl">
                {selected.name ?? "Untitled"}
              </div>
              <Dots count={count} active={index} />
            </div>
            {count > 1 && <Chevron dir="right" onClick={next} />}
          </div>

          {/* Primary action */}
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

          {/* Secondary actions */}
          <div className="flex items-center gap-3">
            <Link href={`/race/random?car=${selected.id}`} className="btn-ghost px-5 py-2.5 text-sm">
              Practice
            </Link>
            <button type="button" onClick={() => setModalOpen(true)} className="btn-ghost px-5 py-2.5 text-sm">
              + Add car
            </button>
          </div>
        </div>
      )}

      {modalOpen && <CreateCarModal onClose={() => setModalOpen(false)} onCreated={onCreated} />}
    </main>
  );
}

function ProfileChip({ username }: { username: string }) {
  const initial = username.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="game-panel flex items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-b from-cyan-300 to-cyan-600 font-heading text-sm font-bold text-[#04131b]">
        {initial}
      </span>
      <span className="max-w-[9rem] truncate text-sm font-medium">{username}</span>
    </div>
  );
}

function Dots({ count, active }: { count: number; active: number }) {
  if (count <= 1) return null;
  return (
    <div className="mt-2 flex items-center justify-center gap-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i === active ? "w-5 bg-cyan-400" : "w-1.5 bg-white/25"
          }`}
        />
      ))}
    </div>
  );
}

function Chevron({ dir, onClick }: { dir: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === "left" ? "Previous car" : "Next car"}
      className="flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-white/5 text-2xl text-white/80 backdrop-blur transition hover:border-cyan-400/60 hover:bg-white/10 hover:text-white active:translate-y-px"
    >
      {dir === "left" ? "‹" : "›"}
    </button>
  );
}
