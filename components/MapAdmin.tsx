"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Car } from "@/lib/cars";
import { deviceHeaders } from "@/lib/identity";
import { apiGet } from "@/lib/api";
import { TRACKS, type TrackDef, type Vec3 } from "@/lib/tracks";

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

export function MapAdmin() {
  const router = useRouter();
  const [maps, setMaps] = useState<TrackDef[]>([]);
  const [cars, setCars] = useState<Car[]>([]);
  const [selectedCar, setSelectedCar] = useState("");
  const [selectedMap, setSelectedMap] = useState<TrackDef>(TRACKS[0]);
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
      if (mapResult.status === "fulfilled") setMaps(mapResult.value.maps);
      if (carResult.status === "fulfilled") {
        setCars(carResult.value.cars);
        setSelectedCar(carResult.value.cars[0]?.id || "");
      }
    });
    return () => { cancelled = true; };
  }, []);

  function testMap(map: TrackDef) {
    const params = new URLSearchParams({ laps: String(map.defaultLaps) });
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
      setNotice(`${map.name} is ready to test.`);
      formElement.reset();
      setFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the map.");
    } finally {
      setSaving(false);
    }
  }

  async function removeMap(map: TrackDef) {
    if (!window.confirm(`Delete ${map.name}?`)) return;
    try {
      await parseResponse<{ ok: boolean }>(
        await fetch(`/api/maps/${map.id}`, { method: "DELETE", headers: deviceHeaders() }),
      );
      setMaps((current) => current.filter((item) => item.id !== map.id));
      if (selectedMap.id === map.id) setSelectedMap(TRACKS[0]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the map.");
    }
  }

  return (
    <main className="min-h-dvh overflow-x-hidden bg-[#070b12] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(34,211,238,0.12),transparent_35%),radial-gradient(circle_at_90%_35%,rgba(249,115,22,0.08),transparent_30%)]" />
      <div className="relative mx-auto max-w-[1500px] px-5 py-6 lg:px-8">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-5 border-b border-white/10 pb-6">
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.38em] text-cyan-300/70">Draw &amp; Drive / Admin</div>
            <h1 className="font-heading text-4xl font-bold uppercase italic tracking-tight md:text-6xl">Map <span className="text-cyan-300">Lab</span></h1>
            <p className="mt-2 max-w-xl text-sm text-white/50">Import a raw GLB environment and free-drive it with any car from your garage.</p>
          </div>
          <Link href="/" className="btn-ghost px-5 py-2.5 text-xs">Back to garage</Link>
        </header>

        <section className="mb-7 grid gap-4 sm:grid-cols-3">
          <Metric value={String(TRACKS.length + maps.length).padStart(2, "0")} label="Maps online" />
          <Metric value={String(cars.length).padStart(2, "0")} label="Test vehicles" />
          <Metric value="FREE" label="Drive mode" />
        </section>

        <div className="grid gap-7 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.75fr)]">
          <section>
            <div className="mb-3 flex items-end justify-between">
              <div><p className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-300/65">Map library</p><h2 className="font-heading text-2xl font-bold uppercase">Choose a test ground</h2></div>
              <span className="font-mono text-xs text-white/35">{TRACKS.length + maps.length} available</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {[...maps, ...TRACKS].map((map) => (
                <MapCard key={map.id} map={map} active={selectedMap.id === map.id} custom={map.id.startsWith("custom-")} onSelect={() => setSelectedMap(map)} onTest={() => testMap(map)} onDelete={() => void removeMap(map)} />
              ))}
            </div>

            <div className="game-panel mt-5 rounded-2xl p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div><div className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/35">Test configuration</div><div className="mt-1 font-heading text-xl font-bold uppercase">{selectedMap.name}</div></div>
                <label className="min-w-56 text-xs text-white/50">Test vehicle
                  <select value={selectedCar} onChange={(event) => setSelectedCar(event.target.value)} className="mt-1 block w-full rounded-lg border border-white/10 bg-[#0d1420] px-3 py-2 text-sm text-white outline-none focus:border-cyan-400">
                    <option value="">Placeholder car</option>
                    {cars.map((car) => <option key={car.id} value={car.id}>{car.name || "Untitled car"}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => testMap(selectedMap)} className="btn-race px-7 py-3 text-sm">Run test</button>
              </div>
            </div>
          </section>

          <aside>
            <form onSubmit={saveMap} className="game-panel sticky top-5 rounded-2xl p-5 sm:p-6">
              <div className="mb-5 flex items-center justify-between">
                <div><p className="font-mono text-[10px] uppercase tracking-[0.25em] text-orange-300/70">New environment</p><h2 className="font-heading text-2xl font-bold uppercase">Add custom map</h2></div>
                <span className="rounded-full border border-orange-300/20 bg-orange-300/10 px-2.5 py-1 font-mono text-[10px] text-orange-200">DRAFT</span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Map name" className="sm:col-span-2"><input name="name" required maxLength={60} placeholder="Dockyard Zero" className="map-input" /></Field>
                <Field label="Description" className="sm:col-span-2"><input name="blurb" maxLength={140} placeholder="Fast industrial test loop" className="map-input" /></Field>
                <Field label="Environment GLB" className="sm:col-span-2">
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-white/15 bg-black/20 p-3 transition hover:border-cyan-400/50">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-400/10 text-lg text-cyan-300">↑</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm text-white/80">{file?.name || "Choose a self-contained .glb"}</span><span className="text-[11px] text-white/35">Maximum 50 MB</span></span>
                    <input type="file" accept=".glb,model/gltf-binary" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="sr-only" />
                  </label>
                </Field>
                <Field label="Or model URL" className="sm:col-span-2"><input name="modelUrl" type="text" placeholder="https://.../map.glb" className="map-input" /></Field>
                <Field label="Model scale"><input name="modelScale" type="number" min="0.01" max="100" step="0.01" defaultValue="1" className="map-input" /></Field>
                <Field label="Ground"><input name="groundColor" type="color" defaultValue="#263238" className="map-color" /></Field>
                <Field label="Sky"><input name="skyColor" type="color" defaultValue="#8ecae6" className="map-color" /></Field>
              </div>
              {error && <div role="alert" className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</div>}
              {notice && <div className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">{notice}</div>}
              <button type="submit" disabled={saving} className="btn-race mt-5 w-full px-6 py-3 text-sm">{saving ? "Uploading…" : "Save custom map"}</button>
            </form>
          </aside>
        </div>
      </div>
    </main>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3"><div className="font-heading text-2xl font-bold text-cyan-200">{value}</div><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">{label}</div></div>;
}

function Field({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return <label className={`block text-xs text-white/55 ${className}`}><span className="mb-1.5 flex justify-between"><span>{label}</span>{hint && <span className="font-mono text-[10px] text-cyan-300/60">{hint}</span>}</span>{children}</label>;
}

function MapCard({ map, active, custom, onSelect, onTest, onDelete }: { map: TrackDef; active: boolean; custom: boolean; onSelect: () => void; onTest: () => void; onDelete: () => void }) {
  return (
    <article onClick={onSelect} className={`group relative cursor-pointer overflow-hidden rounded-2xl border p-4 transition ${active ? "border-cyan-400/70 bg-cyan-400/[0.08] shadow-[0_0_30px_rgba(34,211,238,0.08)]" : "border-white/10 bg-white/[0.03] hover:border-white/25"}`}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: map.accent }} />
      <div className="flex gap-4"><div className="w-28 shrink-0">{map.gates.length > 0 ? <RoutePreview points={map.gates.map((gate) => gate.position)} compact accent={map.accent} /> : <div className="flex aspect-square items-center justify-center rounded-xl border border-white/10 bg-[#071018] font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/60">Free drive</div>}</div><div className="min-w-0 flex-1"><div className="mb-1 flex items-center gap-2"><h3 className="truncate font-heading text-lg font-bold uppercase">{map.name}</h3><span className={`rounded px-1.5 py-0.5 font-mono text-[8px] uppercase ${custom ? "bg-orange-300/10 text-orange-200" : "bg-white/10 text-white/45"}`}>{custom ? "Custom" : "Stock"}</span></div><p className="line-clamp-2 min-h-8 text-xs text-white/40">{map.blurb}</p><div className="mt-2 flex gap-3 font-mono text-[9px] uppercase text-white/35">{map.gates.length > 0 ? <><span>{map.gates.length} gates</span><span>{map.defaultLaps} laps</span></> : <span>No checkpoints</span>}</div></div></div>
      <div className="mt-3 flex gap-2 border-t border-white/5 pt-3"><button type="button" onClick={(event) => { event.stopPropagation(); onTest(); }} className="flex-1 rounded-lg bg-cyan-400 px-3 py-2 font-heading text-xs font-bold uppercase tracking-wider text-[#04131b] transition hover:bg-cyan-300">Test drive</button>{custom && <button type="button" aria-label={`Delete ${map.name}`} onClick={(event) => { event.stopPropagation(); onDelete(); }} className="rounded-lg border border-white/10 px-3 text-sm text-white/40 transition hover:border-red-400/40 hover:text-red-300">×</button>}</div>
    </article>
  );
}

function RoutePreview({ points, compact = false, accent = "#22d3ee" }: { points: Vec3[]; compact?: boolean; accent?: string }) {
  const projected = useMemo(() => {
    if (!points.length) return "";
    const xs = points.map((point) => point[0]); const zs = points.map((point) => point[2]);
    const minX = Math.min(...xs); const maxX = Math.max(...xs); const minZ = Math.min(...zs); const maxZ = Math.max(...zs);
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    return points.map((point) => `${12 + ((point[0] - minX) / span) * 96},${12 + ((point[2] - minZ) / span) * 96}`).join(" ");
  }, [points]);
  return <div className={`overflow-hidden rounded-xl border border-white/10 bg-[#071018] ${compact ? "aspect-square" : "h-40"}`}><svg viewBox="0 0 120 120" className="h-full w-full"><defs><pattern id="map-grid" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M 12 0 L 0 0 0 12" fill="none" stroke="rgba(255,255,255,.045)" strokeWidth=".5" /></pattern></defs><rect width="120" height="120" fill="url(#map-grid)" /><polygon points={projected} fill={`${accent}10`} stroke={accent} strokeWidth="2" strokeLinejoin="round" />{projected.split(" ").filter(Boolean).map((pair, index) => { const [cx, cy] = pair.split(","); return <circle key={`${pair}-${index}`} cx={cx} cy={cy} r={index === 0 ? 3.5 : 2} fill={index === 0 ? "#fff" : accent} />; })}</svg></div>;
}
