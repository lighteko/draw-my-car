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
