"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Car } from "@/lib/cars";
import { deviceHeaders } from "@/lib/identity";
import { apiGet } from "@/lib/api";
import type { TrackDef } from "@/lib/tracks";
import { RoutePreview } from "./RoutePreview";

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `요청 실패 (${response.status})`);
  return body as T;
}

export function MapAdmin() {
  const router = useRouter();
  const [maps, setMaps] = useState<TrackDef[]>([]);
  const [cars, setCars] = useState<Car[]>([]);
  const [selectedCar, setSelectedCar] = useState("");
  const [selectedMap, setSelectedMap] = useState<TrackDef | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      apiGet<{ maps: TrackDef[] }>("/api/maps"),
      apiGet<{ cars: Car[] }>("/api/cars"),
    ]).then(([mapResult, carResult]) => {
      if (cancelled) return;
      if (mapResult.status === "fulfilled") {
        setMaps(mapResult.value.maps);
        setSelectedMap(mapResult.value.maps[0] ?? null);
      }
      if (carResult.status === "fulfilled") {
        setCars(carResult.value.cars);
        setSelectedCar(carResult.value.cars[0]?.id || "");
      }
    });
    return () => { cancelled = true; };
  }, []);

  // admin=1 opens the race with the authoring panels (tuning, graphics, checkpoints).
  function testMap(map: TrackDef) {
    const params = new URLSearchParams({ laps: String(map.defaultLaps), admin: "1" });
    if (selectedCar) params.set("car", selectedCar);
    router.push(`/race/${map.id}?${params}`);
  }

  async function saveMap(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      form.set("points", "[]");
      if (file) form.set("model", file);
      const { map } = await parseResponse<{ map: TrackDef }>(
        await fetch("/api/maps", { method: "POST", headers: deviceHeaders(), body: form }),
      );
      setMaps((current) => [map, ...current]);
      setSelectedMap(map);
      setNotice(`${map.name} 맵을 테스트할 수 있습니다.`);
      formElement.reset();
      setFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "맵을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function removeMap(map: TrackDef) {
    if (!window.confirm(`${map.name} 맵을 삭제할까요?`)) return;
    try {
      await parseResponse<{ ok: boolean }>(
        await fetch(`/api/maps/${map.id}`, { method: "DELETE", headers: deviceHeaders() }),
      );
      const remaining = maps.filter((item) => item.id !== map.id);
      setMaps(remaining);
      if (selectedMap?.id === map.id) setSelectedMap(remaining[0] ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "맵을 삭제하지 못했습니다.");
    }
  }

  return (
    <main className="min-h-dvh overflow-x-hidden bg-[#17110b] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(224,168,78,0.12),transparent_35%),radial-gradient(circle_at_90%_35%,rgba(249,115,22,0.08),transparent_30%)]" />
      <div className="relative mx-auto max-w-[1500px] px-5 py-6 lg:px-8">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-5 border-b border-white/10 pb-6">
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.38em] text-amber-300/70">AI 바이블 드라이브 / 관리자</div>
            <h1 className="font-display text-4xl font-bold tracking-tight md:text-6xl">맵 <span className="text-amber-300">제작실</span></h1>
            <p className="mt-2 max-w-xl text-sm text-white/50">GLB 환경을 올리고 차고의 차량으로 자유 주행해 보세요.</p>
          </div>
          <Link href="/" className="btn-ghost px-5 py-2.5 text-xs">차고로 돌아가기</Link>
        </header>

        <section className="mb-7 grid gap-4 sm:grid-cols-3">
          <Metric value={String(maps.length).padStart(2, "0")} label="등록된 맵" />
          <Metric value={String(cars.length).padStart(2, "0")} label="테스트 차량" />
          <Metric value="자유" label="주행 모드" />
        </section>

        <div className="grid gap-7 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.75fr)]">
          <section>
            <div className="mb-3 flex items-end justify-between">
              <div><p className="font-mono text-[10px] uppercase tracking-[0.25em] text-amber-300/65">맵 목록</p><h2 className="font-display text-2xl font-bold uppercase">테스트할 맵 고르기</h2></div>
              <span className="font-mono text-xs text-white/35">{maps.length}개</span>
            </div>
            {maps.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-white/12 bg-white/[0.02] px-5 py-8 text-center text-sm text-white/40">
                아직 맵이 없습니다 — GLB 환경을 올려 첫 맵을 만들어 보세요.
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {maps.map((map) => (
                  <MapCard key={map.id} map={map} active={selectedMap?.id === map.id} onSelect={() => setSelectedMap(map)} onTest={() => testMap(map)} onDelete={() => void removeMap(map)} />
                ))}
              </div>
            )}

            <div className="game-panel mt-5 rounded-2xl p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div><div className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/35">테스트 설정</div><div className="mt-1 font-heading text-xl font-bold uppercase">{selectedMap?.name ?? "선택된 맵 없음"}</div></div>
                <label className="min-w-56 text-xs text-white/50">테스트 차량
                  <select value={selectedCar} onChange={(event) => setSelectedCar(event.target.value)} className="mt-1 block w-full rounded-lg border border-white/10 bg-[#241a12] px-3 py-2 text-sm text-white outline-none focus:border-amber-400">
                    <option value="">기본 차량</option>
                    {cars.map((car) => <option key={car.id} value={car.id}>{car.name || "이름 없는 차량"}</option>)}
                  </select>
                </label>
                <button type="button" disabled={!selectedMap} onClick={() => selectedMap && testMap(selectedMap)} className="btn-race px-7 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-40">테스트 시작</button>
              </div>
            </div>
          </section>

          <aside>
            <form onSubmit={saveMap} className="game-panel sticky top-5 rounded-2xl p-5 sm:p-6">
              <div className="mb-5 flex items-center justify-between">
                <div><p className="font-mono text-[10px] uppercase tracking-[0.25em] text-orange-300/70">새 환경</p><h2 className="font-display text-2xl font-bold uppercase">맵 추가</h2></div>
                <span className="rounded-full border border-orange-300/20 bg-orange-300/10 px-2.5 py-1 font-mono text-[10px] text-orange-200">임시</span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="맵 이름" className="sm:col-span-2"><input name="name" required maxLength={60} placeholder="여리고 성벽" className="map-input" /></Field>
                <Field label="설명" className="sm:col-span-2"><input name="blurb" maxLength={140} placeholder="성벽을 도는 빠른 코스" className="map-input" /></Field>
                <Field label="환경 GLB" className="sm:col-span-2">
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-white/15 bg-black/20 p-3 transition hover:border-amber-400/50">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-400/10 text-lg text-amber-300">↑</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm text-white/80">{file?.name || "자체 포함된 .glb 파일 선택"}</span><span className="text-[11px] text-white/35">최대 50 MB</span></span>
                    <input type="file" accept=".glb,model/gltf-binary" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="sr-only" />
                  </label>
                </Field>
                <Field label="또는 모델 URL" className="sm:col-span-2"><input name="modelUrl" type="text" placeholder="https://.../map.glb" className="map-input" /></Field>
                <Field label="모델 배율"><input name="modelScale" type="number" min="0.01" max="100" step="0.01" defaultValue="1" className="map-input" /></Field>
                <Field label="바닥 색"><input name="groundColor" type="color" defaultValue="#8a6a45" className="map-color" /></Field>
                <Field label="하늘 색"><input name="skyColor" type="color" defaultValue="#e8c88f" className="map-color" /></Field>
              </div>
              {error && <div role="alert" className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</div>}
              {notice && <div className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">{notice}</div>}
              <button type="submit" disabled={saving} className="btn-race mt-5 w-full px-6 py-3 text-sm">{saving ? "업로드 중…" : "맵 저장"}</button>
            </form>
          </aside>
        </div>
      </div>
    </main>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3"><div className="font-display text-2xl font-bold text-amber-200">{value}</div><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">{label}</div></div>;
}

function Field({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return <label className={`block text-xs text-white/55 ${className}`}><span className="mb-1.5 flex justify-between"><span>{label}</span>{hint && <span className="font-mono text-[10px] text-amber-300/60">{hint}</span>}</span>{children}</label>;
}

function MapCard({ map, active, onSelect, onTest, onDelete }: { map: TrackDef; active: boolean; onSelect: () => void; onTest: () => void; onDelete: () => void }) {
  return (
    <article onClick={onSelect} className={`group relative cursor-pointer overflow-hidden rounded-2xl border p-4 transition ${active ? "border-amber-400/70 bg-amber-400/[0.08] shadow-[0_0_30px_rgba(224,168,78,0.08)]" : "border-white/10 bg-white/[0.03] hover:border-white/25"}`}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: map.accent }} />
      <div className="flex gap-4"><div className="w-28 shrink-0">{map.gates.length > 0 ? <RoutePreview points={map.gates.map((gate) => gate.position)} compact accent={map.accent} /> : <div className="flex aspect-square items-center justify-center rounded-xl border border-white/10 bg-[#1b1209] font-mono text-[10px] uppercase tracking-[0.18em] text-amber-300/60">자유 주행</div>}</div><div className="min-w-0 flex-1"><div className="mb-1 flex items-center gap-2"><h3 className="truncate font-heading text-lg font-bold uppercase">{map.name}</h3>{map.official && <span className="shrink-0 rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-amber-200">공식</span>}</div><p className="line-clamp-2 min-h-8 text-xs text-white/40">{map.blurb}</p><div className="mt-2 flex gap-3 font-mono text-[9px] uppercase text-white/35">{map.gates.length > 0 ? <><span>체크포인트 {map.gates.length}개</span><span>{map.defaultLaps}바퀴</span></> : <span>체크포인트 없음</span>}</div></div></div>
      <div className="mt-3 flex gap-2 border-t border-white/5 pt-3"><button type="button" onClick={(event) => { event.stopPropagation(); onTest(); }} className="flex-1 rounded-lg bg-amber-400 px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-[#2a1608] transition hover:bg-amber-300">테스트 주행</button>{!map.official && <button type="button" aria-label={`${map.name} 삭제`} onClick={(event) => { event.stopPropagation(); onDelete(); }} className="rounded-lg border border-white/10 px-3 text-sm text-white/40 transition hover:border-red-400/40 hover:text-red-300">×</button>}</div>
    </article>
  );
}

