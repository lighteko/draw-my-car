"use client";

import dynamic from "next/dynamic";

/**
 * SimulatorClient — the seam that keeps the three.js scene out of SSR.
 *
 * `dynamic(..., { ssr: false })` is only allowed inside a Client Component (App Router),
 * so this thin "use client" wrapper does the dynamic import. A server page can render
 * <SimulatorClient/> safely; the WebGL/window-dependent Simulator only loads in the browser.
 */
const Simulator = dynamic(() => import("./Simulator"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-neutral-900 font-mono text-sm text-neutral-400">
      Loading simulator…
    </div>
  ),
});

export default function SimulatorClient({ carId }: { carId: string }) {
  return <Simulator carId={carId} />;
}
