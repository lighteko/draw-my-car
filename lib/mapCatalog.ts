"use client";

import { apiGet } from "@/lib/api";
import type { TrackDef } from "@/lib/tracks";

/**
 * mapCatalog.ts — client-side access to the admin map library.
 *
 * The only tracks that exist are the ones an admin uploaded in the map lab, so every
 * lookup goes through /api/maps instead of a bundled catalogue. lib/maps.ts (the store)
 * is server-only — it touches the filesystem — which is why these helpers live here.
 */

/** Settings value meaning "pick a map when the race starts". */
export const RANDOM_TRACK_ID = "random";

/** The whole library, newest first (the order the API returns). */
export async function fetchMaps(): Promise<TrackDef[]> {
  const { maps } = await apiGet<{ maps: TrackDef[] }>("/api/maps");
  return maps;
}

/** One map by id, or null when it is gone (deleted between selection and race). */
export async function fetchMap(id: string): Promise<TrackDef | null> {
  try {
    const { map } = await apiGet<{ map: TrackDef }>(`/api/maps/${encodeURIComponent(id)}`);
    return map;
  } catch {
    return null;
  }
}

export function pickRandomMap(maps: TrackDef[]): TrackDef | null {
  if (maps.length === 0) return null;
  return maps[Math.floor(Math.random() * maps.length)];
}

export function mapName(maps: TrackDef[], id: string): string {
  return maps.find((map) => map.id === id)?.name ?? id;
}

/**
 * Resolve a settings trackId for a solo race: a real id if it still exists, otherwise a
 * random map. Multiplayer must NOT use the random branch per client — the lobby resolves
 * "random" once and broadcasts the concrete id (see `resolveSharedTrack`).
 */
export async function resolveSoloTrack(trackId: string): Promise<TrackDef | null> {
  if (trackId && trackId !== RANDOM_TRACK_ID) {
    const map = await fetchMap(trackId);
    if (map) return map;
  }
  return pickRandomMap(await fetchMaps());
}

/**
 * Resolve a settings trackId for a shared race. Falls back to the newest map rather than a
 * random one so every client that has to fall back lands on the same track.
 */
export async function resolveSharedTrack(trackId: string): Promise<TrackDef | null> {
  if (trackId && trackId !== RANDOM_TRACK_ID) {
    const map = await fetchMap(trackId);
    if (map) return map;
  }
  return (await fetchMaps())[0] ?? null;
}
