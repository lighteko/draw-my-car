"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePlayer } from "@/lib/identity";
import { apiGet } from "@/lib/api";
import type { Car } from "@/lib/cars";
import { CreateCarModal } from "@/components/CreateCarModal";

/**
 * Home = the garage. A rotating turntable of the device's cars with a Play button.
 * The turntable is WebGL, so it's dynamic-imported client-only (ssr: false).
 */
const GarageTurntable = dynamic(
  () => import("@/components/GarageTurntable").then((m) => m.GarageTurntable),
  { ssr: false, loading: () => <div className="h-full w-full" /> },
);

const ACTIVE_CAR_KEY = "dmc_active_car";

export default function Home() {
  const { username, ready } = usePlayer();
  const [cars, setCars] = useState<Car[] | null>(null);
  const [index, setIndex] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

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

  // Remember the active car for the (next-phase) racing flow.
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

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-gradient-to-b from-neutral-700 via-neutral-900 to-black text-white">
      <div className="absolute inset-0">
        <GarageTurntable glbUrl={selected?.glbUrl ?? null} />
      </div>

      {/* Top bar */}
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5">
        <div>
          <div className="font-mono text-xs uppercase tracking-widest text-emerald-400">
            Sketch-to-Drive
          </div>
          <div className="text-lg font-bold">Garage</div>
        </div>
        {ready && (
          <div className="pointer-events-auto rounded-full bg-white/10 px-3 py-1.5 text-sm backdrop-blur">
            {username}
          </div>
        )}
      </header>

      {/* Empty state */}
      {cars !== null && count === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="pointer-events-auto flex flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-white/25 px-14 py-12 text-center transition hover:border-emerald-400/70 hover:bg-white/5"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 text-4xl font-light leading-none shadow-lg">
              +
            </span>
            <span className="text-lg font-semibold">Create your first car</span>
            <span className="max-w-xs text-sm text-neutral-400">
              Draw a car and we&apos;ll turn it into a drivable 3D model.
            </span>
          </button>
        </div>
      )}

      {/* Car name + carousel nav */}
      {selected && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 flex items-center justify-center gap-8">
          {count > 1 && <NavArrow dir="left" onClick={prev} />}
          <div className="text-center">
            <div className="text-xl font-semibold">{selected.name ?? "Untitled car"}</div>
            <div className="mt-1 text-xs text-neutral-400">
              {index + 1} / {count}
            </div>
          </div>
          {count > 1 && <NavArrow dir="right" onClick={next} />}
        </div>
      )}

      {/* Bottom action bar */}
      <div className="absolute inset-x-0 bottom-6 flex items-center justify-center gap-3 px-4">
        {count > 0 && (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded-full border border-white/20 bg-white/5 px-4 py-3 text-sm font-medium backdrop-blur transition hover:bg-white/10"
          >
            + Add car
          </button>
        )}

        <button
          type="button"
          disabled
          title="Multiplayer rooms arrive in the next update"
          className="relative rounded-full bg-emerald-600/50 px-10 py-3 text-base font-bold text-white/70 shadow-lg"
        >
          Play
          <span className="absolute -right-2 -top-2 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold text-black">
            soon
          </span>
        </button>

        {selected && (
          <Link
            href={`/simulate/${selected.id}`}
            className="rounded-full border border-white/20 bg-white/5 px-4 py-3 text-sm font-medium backdrop-blur transition hover:bg-white/10"
          >
            Test drive
          </Link>
        )}
      </div>

      {modalOpen && (
        <CreateCarModal onClose={() => setModalOpen(false)} onCreated={onCreated} />
      )}
    </main>
  );
}

function NavArrow({ dir, onClick }: { dir: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/5 text-xl backdrop-blur transition hover:bg-white/15"
      aria-label={dir === "left" ? "Previous car" : "Next car"}
    >
      {dir === "left" ? "‹" : "›"}
    </button>
  );
}
