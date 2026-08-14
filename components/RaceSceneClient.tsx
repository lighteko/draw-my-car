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
      <div className="flex h-dvh w-full items-center justify-center bg-[#17110b] font-mono text-sm text-[#d9c193]/70">
        레이스 불러오는 중…
      </div>
    ),
  },
);
