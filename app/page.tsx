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
 * panel, a car-select sidebar (render thumbnails), a drag-to-spin hero turntable, and a big
 * PLAY action. Turntable is WebGL (dynamic, ssr:false).
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
  // No car is fine — the race falls back to the placeholder rig. Only Supabase gates hosting.
  const canPlay = multiplayer;

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
    <main className="garage-page game-bg relative h-dvh w-full overflow-hidden text-white">
      <div className="absolute inset-0">
        <GarageTurntable glbUrl={selected?.glbUrl ?? null} />
      </div>

      {/* Legibility vignettes */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/80 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/90 via-black/45 to-transparent" />

      {/* Top HUD */}
      <header className="garage-header safe-t safe-x absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3">
        <div>
          <div className="neon-title text-2xl leading-none sm:text-3xl">
            AI <span className="text-amber-300">바이블</span> 드라이브
          </div>
          <div className="garage-kicker mt-0.5 font-mono text-[10px] uppercase tracking-[0.35em] text-amber-400/70">
            차고
          </div>
        </div>
        {/* No map-lab link: it is an admin tool, reached by typing /admin/maps, not something
            players should find in the garage. The route still guards itself with a password. */}
        <div className="flex items-center gap-2">
          <div className="game-panel hidden items-center gap-2 rounded-full px-4 py-2 text-sm sm:flex">
            <span className="text-amber-300">◈</span> 차량 {count}대
          </div>
          {ready && <ProfileChip username={username} onEdit={() => setEditingName(true)} />}
        </div>
      </header>

      {/* Empty state */}
      {cars !== null && count === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
          <div className="garage-empty game-panel dmc-rise flex max-w-sm flex-col items-center gap-4 rounded-3xl p-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-b from-amber-300 to-amber-600 text-4xl font-light leading-none text-[#2a1608] shadow-[0_0_30px_rgba(224,168,78,0.5)]">
              +
            </span>
            <h2 className="font-display text-2xl font-bold uppercase tracking-wide">
              첫 차를 만들어 보세요
            </h2>
            <p className="text-sm text-white/60">
              그림을 그리면 달릴 수 있는 3D 차량으로 만들어 드립니다.
            </p>
            <button type="button" onClick={() => setModalOpen(true)} className="btn-race mt-1 px-8 py-3.5 text-base">
              차 그리기
            </button>
            {/* Nothing drawn yet is no reason to sit in the garage — the race scene falls
                back to the placeholder rig when no car GLB is given. */}
            <div className="garage-empty-practice flex flex-wrap items-center justify-center gap-2">
              <Link
                href="/race/random"
                onClick={() => {
                  if (isTouchDevice()) void enterFullscreen();
                }}
                className="btn-ghost px-4 py-2 text-xs"
              >
                기본 차량으로 연습
              </Link>
              {multiplayer && (
                <button
                  type="button"
                  onClick={play}
                  disabled={creatingRoom}
                  className="btn-ghost px-4 py-2 text-xs"
                >
                  {creatingRoom ? "방 만드는 중…" : "기본 차량으로 방 만들기"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Left car-info panel (desktop) */}
      {selected && (
        <aside className="garage-info safe-x pointer-events-none absolute left-0 top-24 z-10 hidden md:block">
          <CarInfoPanel car={selected} />
        </aside>
      )}

      {/* Car-select sidebar: right column on desktop, bottom strip on mobile */}
      {cars !== null && count > 0 && (
        <div className="garage-car-selector absolute bottom-32 inset-x-0 z-10 flex gap-2 overflow-x-auto px-4 md:inset-x-auto md:right-3 md:top-24 md:bottom-36 md:w-24 md:flex-col md:overflow-x-hidden md:overflow-y-auto md:px-0">
          {cars.map((car, i) => (
            <CarThumb key={car.id} car={car} active={i === Math.min(index, count - 1)} onClick={() => setIndex(i)} />
          ))}
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            aria-label="차 추가"
            className="garage-car-thumb flex aspect-square w-20 shrink-0 items-center justify-center rounded-xl border border-dashed border-white/25 text-2xl text-white/60 transition hover:border-amber-400/60 hover:text-white md:w-full"
          >
            +
          </button>
        </div>
      )}

      {/* Bottom action cluster */}
      {selected && (
        <div className="garage-actions safe-b safe-x absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-3 pb-2">
          <div className="garage-car-name font-heading text-xl font-bold uppercase italic tracking-wide md:hidden">
            {selected.name ?? "이름 없음"}
          </div>
          <button
            type="button"
            onClick={play}
            disabled={!canPlay || creatingRoom}
            title={
              multiplayer
                ? "방을 만들고 친구를 초대합니다"
                : "멀티플레이는 Supabase 설정이 필요합니다"
            }
            className="btn-race w-64 max-w-[80vw] px-10 py-4 text-lg"
          >
            {creatingRoom ? (
              "방 만드는 중…"
            ) : (
              <>
                <span aria-hidden>▶</span> 플레이
              </>
            )}
            {!multiplayer && (
              <span className="absolute -right-2 -top-2 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-medium not-italic text-black">
                준비 중
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
            연습 주행
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
      className="game-panel flex items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-3 transition hover:border-amber-400/50"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-b from-amber-300 to-amber-600 font-heading text-sm font-bold text-[#2a1608]">
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
      aria-label={car.name ?? "차량"}
      className={`garage-car-thumb aspect-square w-20 shrink-0 overflow-hidden rounded-xl border bg-black/40 transition md:w-full ${
        active ? "border-amber-400 ring-2 ring-amber-400/40" : "border-white/15 hover:border-white/40"
      }`}
    >
      {car.renderUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={car.renderUrl} alt={car.name ?? "차량"} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-heading text-lg font-bold text-white/70">
          {(car.name ?? "?").charAt(0).toUpperCase()}
        </span>
      )}
    </button>
  );
}

function CarInfoPanel({ car }: { car: Car }) {
  const created = new Date(car.createdAt);
  return (
    <div className="game-panel w-72 rounded-2xl p-5">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber-400/70">
        내가 만든 차
      </div>
      <h2 className="font-display text-2xl font-bold leading-tight tracking-wide">
        {car.name ?? "이름 없음"}
      </h2>
      <dl className="mt-4 space-y-2 text-[11px]">
        <Fact label="만든 날">
          {`${created.getFullYear()}. ${created.getMonth() + 1}. ${created.getDate()}.`}
        </Fact>
        <Fact label="3D 모델">{car.glbUrl ? "완성" : "기본 차량으로 주행"}</Fact>
      </dl>
    </div>
  );
}

/**
 * Only things the game can actually back up. The old panel showed top speed / acceleration /
 * handling bars derived from a hash of the car id — they looked like a spec sheet but had no
 * effect on the drive, so every car was secretly identical.
 */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/45">{label}</dt>
      <dd className="truncate font-medium text-white/85">{children}</dd>
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
    <div className="nickname-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="nickname-dialog game-panel dmc-rise w-full max-w-sm rounded-2xl p-6">
        <h2 className="font-heading text-xl font-bold uppercase tracking-wide">드라이버 이름</h2>
        <p className="mt-1 text-sm text-white/55">다른 참가자에게 이 이름으로 보입니다.</p>
        <input
          autoFocus
          value={name}
          maxLength={20}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed) onSave(trimmed);
          }}
          className="mt-4 w-full rounded-lg border border-white/15 bg-black/40 px-4 py-2.5 text-white outline-none transition focus:border-amber-400"
        />
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="btn-ghost px-5 py-2.5 text-sm">
            취소
          </button>
          <button
            type="button"
            disabled={!trimmed}
            onClick={() => onSave(trimmed)}
            className="btn-race px-6 py-2.5 text-sm"
          >
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

