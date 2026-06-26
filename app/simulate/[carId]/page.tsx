import Link from "next/link";
import SimulatorClient from "@/components/SimulatorClient";

/**
 * /simulate/[carId] — the driving scene for a finished car.
 *
 * Server component: it only resolves the route param and renders the client-only
 * <SimulatorClient/> (which dynamic-imports the WebGL scene with ssr:false). In v0 any
 * carId renders the placeholder car; in v1 carId resolves to a generated GLB.
 */
export default async function SimulatePage({
  params,
}: {
  params: Promise<{ carId: string }>;
}) {
  const { carId } = await params;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-neutral-900">
      <SimulatorClient carId={carId} />

      <Link
        href="/"
        className="absolute left-4 top-4 z-10 rounded-md bg-black/45 px-3 py-1.5 font-mono text-xs text-white backdrop-blur transition hover:bg-black/65"
      >
        ← back
      </Link>
    </main>
  );
}
