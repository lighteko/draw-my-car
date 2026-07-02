import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RigSpec } from "@/lib/rig";
import { getServiceClient, hasSupabase } from "@/lib/supabase";

/**
 * cars.ts - a player's generated cars.
 *
 * Backed by the Supabase `cars` table when configured, else a local .data/cars.json file
 * (same fallback pattern as lib/db.ts) so the garage works in bare local dev too.
 */

export interface Car {
  id: string;
  ownerDeviceId: string;
  name: string | null;
  renderUrl: string | null;
  glbUrl: string | null;
  /** Cached physics rig (nullable; derived client-side from the GLB otherwise). */
  rigSpec: RigSpec | null;
  status: string;
  createdAt: number;
}

export interface NewCar {
  ownerDeviceId: string;
  name?: string | null;
  renderUrl?: string | null;
  glbUrl?: string | null;
  rigSpec?: RigSpec | null;
}

// ---------------------------------------------------------------------------
// Supabase-backed store
// ---------------------------------------------------------------------------

interface CarRow {
  id: string;
  owner_device_id: string;
  name: string | null;
  render_url: string | null;
  glb_url: string | null;
  rig_spec: RigSpec | null;
  status: string;
  created_at: string;
}

function rowToCar(r: CarRow): Car {
  return {
    id: r.id,
    ownerDeviceId: r.owner_device_id,
    name: r.name,
    renderUrl: r.render_url,
    glbUrl: r.glb_url,
    rigSpec: r.rig_spec,
    status: r.status,
    createdAt: new Date(r.created_at).getTime(),
  };
}

async function sbCreate(init: NewCar): Promise<Car> {
  const { data, error } = await getServiceClient()
    .from("cars")
    .insert({
      owner_device_id: init.ownerDeviceId,
      name: init.name ?? null,
      render_url: init.renderUrl ?? null,
      glb_url: init.glbUrl ?? null,
      rig_spec: init.rigSpec ?? null,
      status: "ready",
    })
    .select("*")
    .single();
  if (error) throw new Error(`failed to create car: ${error.message}`);
  return rowToCar(data as CarRow);
}

async function sbList(ownerDeviceId: string): Promise<Car[]> {
  const { data, error } = await getServiceClient()
    .from("cars")
    .select("*")
    .eq("owner_device_id", ownerDeviceId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`failed to list cars: ${error.message}`);
  return (data as CarRow[]).map(rowToCar);
}

async function sbGet(id: string): Promise<Car | undefined> {
  const { data, error } = await getServiceClient().from("cars").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`failed to read car: ${error.message}`);
  return data ? rowToCar(data as CarRow) : undefined;
}

// ---------------------------------------------------------------------------
// Local file store (fallback)
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(
  /* turbopackIgnore: true */ process.cwd(),
  process.env.LOCAL_DATA_DIR ?? ".data",
);
const CARS_PATH = path.join(DATA_DIR, "cars.json");
const TMP_PATH = path.join(DATA_DIR, "cars.json.tmp");

function loadCars(): Car[] {
  if (!existsSync(CARS_PATH)) return [];
  const parsed = JSON.parse(readFileSync(CARS_PATH, "utf8")) as unknown;
  return Array.isArray(parsed) ? (parsed as Car[]) : [];
}

function persistCars(cars: Car[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TMP_PATH, `${JSON.stringify(cars, null, 2)}\n`, "utf8");
  renameSync(TMP_PATH, CARS_PATH);
}

function localCreate(init: NewCar): Car {
  const car: Car = {
    id: randomUUID(),
    ownerDeviceId: init.ownerDeviceId,
    name: init.name ?? null,
    renderUrl: init.renderUrl ?? null,
    glbUrl: init.glbUrl ?? null,
    rigSpec: init.rigSpec ?? null,
    status: "ready",
    createdAt: Date.now(),
  };
  const cars = loadCars();
  cars.push(car);
  persistCars(cars);
  return car;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createCar(init: NewCar): Promise<Car> {
  return hasSupabase() ? sbCreate(init) : localCreate(init);
}

export async function listCars(ownerDeviceId: string): Promise<Car[]> {
  return hasSupabase()
    ? sbList(ownerDeviceId)
    : loadCars().filter((c) => c.ownerDeviceId === ownerDeviceId);
}

export async function getCar(id: string): Promise<Car | undefined> {
  return hasSupabase() ? sbGet(id) : loadCars().find((c) => c.id === id);
}
