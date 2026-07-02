"use client";

import dynamic from "next/dynamic";

/**
 * RaceSceneClient — keeps the WebGL RaceScene out of SSR (needs window + WebGL).
 */
export const RaceSceneClient = dynamic(
  () => import("./RaceScene").then((m) => m.RaceScene),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-dvh w-full items-center justify-center bg-neutral-900 font-mono text-sm text-neutral-400">
        Loading race…
      </div>
    ),
  },
);
