"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * identity.ts — device-based identity (no login).
 *
 * A random device id is minted once and kept in localStorage; it is the player's stable
 * identifier across sessions and is sent to the API (x-device-id) and used as the Realtime
 * presence key. A friendly username is stored alongside and editable.
 */

const DEVICE_KEY = "dmc_device_id";
const USERNAME_KEY = "dmc_username";

const ADJECTIVES = ["Turbo", "Neon", "Rusty", "Zippy", "Drifty", "Mighty", "Sonic", "Wild"];
const NOUNS = ["Comet", "Falcon", "Bolt", "Racer", "Piston", "Gecko", "Rocket", "Bandit"];

function randomUsername(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n} ${Math.floor(Math.random() * 90 + 10)}`;
}

/**
 * A v4 UUID that works everywhere. crypto.randomUUID() is only defined in a *secure
 * context*, so on a phone hitting the dev server over http://LAN it's undefined — calling
 * it there throws and crashes the page. Fall back to getRandomValues (available on
 * insecure origins) or Math.random.
 */
function safeUuid(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      /* fall through */
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

let memoryDeviceId = "";

/** Read (minting if needed) the persistent device id. Returns "" during SSR. */
export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = safeUuid();
      window.localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // localStorage blocked (private mode / embedded webview): per-session id.
    if (!memoryDeviceId) memoryDeviceId = safeUuid();
    return memoryDeviceId;
  }
}

let memoryUsername = "";

/** Read (minting a friendly default if needed) the stored username. Returns "" during SSR. */
export function getUsername(): string {
  if (typeof window === "undefined") return "";
  try {
    let name = window.localStorage.getItem(USERNAME_KEY);
    if (!name) {
      name = randomUsername();
      window.localStorage.setItem(USERNAME_KEY, name);
    }
    return name;
  } catch {
    if (!memoryUsername) memoryUsername = randomUsername();
    return memoryUsername;
  }
}

export function setUsername(name: string): void {
  if (typeof window === "undefined") return;
  memoryUsername = name;
  try {
    window.localStorage.setItem(USERNAME_KEY, name);
  } catch {
    /* kept in memory only */
  }
}

/** Header bag identifying the device on API calls. */
export function deviceHeaders(): Record<string, string> {
  return { "x-device-id": getDeviceId() };
}

/** Upsert the players row for this device. Safe to call repeatedly. */
export async function ensurePlayer(deviceId: string, username: string): Promise<void> {
  await fetch("/api/players", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, username }),
  }).catch(() => {
    /* best-effort; identity still works locally without the row */
  });
}

// --- external identity store (read via useSyncExternalStore for SSR-safe hydration) ---

interface Identity {
  deviceId: string;
  username: string;
}

const EMPTY_IDENTITY: Identity = { deviceId: "", username: "" };
const identityListeners = new Set<() => void>();
let identitySnapshot: Identity | null = null;

function identityGetSnapshot(): Identity {
  // Cached so the reference is stable between renders (required by useSyncExternalStore).
  if (!identitySnapshot) {
    identitySnapshot = { deviceId: getDeviceId(), username: getUsername() };
  }
  return identitySnapshot;
}

function identityGetServerSnapshot(): Identity {
  return EMPTY_IDENTITY;
}

function identitySubscribe(listener: () => void): () => void {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}

/** Update the username and notify subscribers. */
export function renameUser(name: string): void {
  setUsername(name);
  identitySnapshot = { deviceId: getDeviceId(), username: name };
  identityListeners.forEach((l) => l());
}

/**
 * Client hook: SSR-safe device id + username (empty on the server, resolved after
 * hydration) and ensures the players row exists. `ready` flips true once resolved.
 */
export function usePlayer(): {
  deviceId: string;
  username: string;
  ready: boolean;
  rename: (name: string) => void;
} {
  const { deviceId, username } = useSyncExternalStore(
    identitySubscribe,
    identityGetSnapshot,
    identityGetServerSnapshot,
  );

  useEffect(() => {
    if (deviceId) void ensurePlayer(deviceId, username);
  }, [deviceId, username]);

  return { deviceId, username, ready: deviceId !== "", rename: renameUser };
}
