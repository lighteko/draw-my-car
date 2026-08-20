"use client";

import { useEffect } from "react";

/**
 * Stops the long-press option menu on touch devices.
 *
 * `-webkit-touch-callout: none` in globals.css only covers WebKit. Chrome on Android — which
 * is what a tablet usually is — ignores it and raises the full context menu after ~500ms of
 * holding, so leaning on the accelerator or holding a lobby button pops "open in new tab /
 * copy link" over the game.
 *
 * Text fields are exempt: the same menu is how you paste a name, and there is no long press to
 * protect there. A real mouse right-click is left alone too, so desktop devtools and the
 * browser's own menu still work — the menu is only a problem when a hold is meant as a hold.
 */
export function SuppressContextMenu() {
  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      // `button: 2` is a genuine right-click; a long press reports 0.
      if (event.button === 2 && !window.matchMedia("(pointer: coarse)").matches) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  return null;
}
