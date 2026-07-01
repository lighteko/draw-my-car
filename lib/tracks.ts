/**
 * tracks.ts — race track catalogue.
 *
 * This phase defines track *metadata* (ids + display names) so the lobby's map picker
 * and "randomize" work. The race phase extends this file with each track's geometry:
 * ground, barriers, ordered checkpoint gates, start-finish line, and spawn grid.
 */

export interface TrackMeta {
  id: string;
  name: string;
  /** One-line flavor for the lobby picker. */
  blurb: string;
}

export const TRACKS: TrackMeta[] = [
  { id: "sunset-circuit", name: "Sunset Circuit", blurb: "Flowing curves, gentle chicane" },
  { id: "dust-bowl", name: "Dust Bowl", blurb: "Wide oval, big drifts" },
  { id: "harbor-loop", name: "Harbor Loop", blurb: "Tight technical dockside" },
];

export function trackName(id: string): string {
  return TRACKS.find((t) => t.id === id)?.name ?? id;
}

export function randomTrackId(): string {
  return TRACKS[Math.floor(Math.random() * TRACKS.length)].id;
}

/** Resolve a settings trackId ("random" or a specific id) to a concrete track id. */
export function resolveTrackId(trackId: string): string {
  return trackId === "random" ? randomTrackId() : trackId;
}
