"use client";

import { useEffect } from "react";

/**
 * fullscreen.ts — best-effort fullscreen + landscape lock for phones.
 *
 * Browsers only allow entering fullscreen from a user gesture, so there's no true
 * "auto on load". We request it on the first tap (useAutoFullscreen) and again when
 * entering a race. iOS Safari on iPhone has no Fullscreen API — the layout's PWA meta
 * makes "Add to Home Screen" launch fullscreen there instead.
 */

export function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(pointer: coarse)").matches ||
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0)
  );
}

export async function enterFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
  };
  try {
    if (!document.fullscreenElement) {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    }
  } catch {
    /* unsupported (e.g. iOS Safari on iPhone) */
  }
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    await orientation?.lock?.("landscape");
  } catch {
    /* orientation lock unsupported / not permitted */
  }
}

/** On touch devices, enter fullscreen on the first tap of the page. */
export function useAutoFullscreen(): void {
  useEffect(() => {
    if (!isTouchDevice()) return;
    const onFirstTap = () => {
      void enterFullscreen();
    };
    window.addEventListener("pointerdown", onFirstTap, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstTap);
  }, []);
}
