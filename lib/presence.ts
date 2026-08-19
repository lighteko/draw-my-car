import type { PresenceMeta } from "./roomTypes";

export function createPresenceSessionId(deviceId: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return `${deviceId}:${cryptoApi.randomUUID()}`;
    } catch {
      /* insecure LAN context */
    }
  }
  return `${deviceId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

/**
 * The current meta for each presence key.
 *
 * Supabase appends to a key's array every time that key re-tracks, so the raw state holds
 * every historical copy. Reading them all resurrects stale state — and because the copies
 * share a sessionId, later de-duplication cannot tell them apart and keeps whichever came
 * first, freezing every peer at the state they joined with. The last entry is the live one.
 */
export function latestPresencePerKey(
  state: Readonly<Record<string, readonly PresenceMeta[]>>,
): PresenceMeta[] {
  return Object.values(state)
    .map((entries) => entries[entries.length - 1])
    .filter((member): member is PresenceMeta => Boolean(member));
}

/**
 * One deterministic roster entry per device. Every client must select the same tab;
 * otherwise duplicate tabs can both believe they own the player's controls.
 */
export function collapsePresence(members: readonly PresenceMeta[]): PresenceMeta[] {
  const canonical = new Map<string, PresenceMeta>();
  members.forEach((member) => {
    const selected = canonical.get(member.deviceId);
    if (!selected || member.sessionId.localeCompare(selected.sessionId) < 0) {
      canonical.set(member.deviceId, member);
    }
  });
  return [...canonical.values()];
}
