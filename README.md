# draw-my-car — Sketch-to-Drive

An interactive web app that converts simple car drawings into a real 3D model that drives
in a simulated environment. Single-image-to-3D (AI) fills in everything the user didn't draw.

## Status: v0 (runnable skeleton)

v0 proves the hard, fun part — driving — and lays down clean seams for the AI pipeline.
**No AI and no external services yet**; everything slow/external is a typed stub.

- Draw or upload a 2D car on the landing page, hit **Generate** (wires the stubbed job flow),
  then **Drive it** — or jump straight to `/simulate/placeholder`.
- The simulator is a React Three Fiber + Rapier physics scene with a placeholder car
  (box chassis + 4 cylinder wheels) rigged to Rapier's raycast vehicle controller,
  a procedural environment (ground, ramps, crates, walls), a chase camera, and a speed HUD.
- Controls: **W/↑** throttle · **S/↓** reverse · **A D / ← →** steer · **Space** brake · **R** reset.

## Run

```bash
npm run dev      # http://localhost:3000
npm run build    # production build
npx tsc --noEmit # typecheck
npm run lint
```

## Stack

Next.js (App Router) · TypeScript · Tailwind v4 · React Three Fiber · drei ·
`@react-three/rapier` (Rapier physics, raycast vehicle controller).

## Architecture (seams for later milestones)

```
app/
  page.tsx                    landing: draw/upload -> POST /api/jobs -> poll -> drive
  simulate/[carId]/page.tsx   server page -> <SimulatorClient> (ssr:false)
  api/
    jobs/route.ts             POST: create job, return jobId
    jobs/[id]/route.ts        GET: status (v0 returns ready + placeholder)
    webhooks/tripo/route.ts   provider completion webhook (stub)
components/
  DrawCanvas.tsx              draw / upload -> PNG data URL
  Simulator.tsx               client-only R3F + Rapier scene
  VehicleRig.tsx              derives a vehicle from a RigSpec (placeholder in v0)
  Hud.tsx                     speed + controls overlay
lib/
  rig.ts                      RigSpec + getPlaceholderRig + (stub) deriveRigFromObject
  providers/{index,tripo}.ts  ModelProvider interface + Tripo stub (two-step flow)
  storage.ts                  R2/S3 wrapper (stub)
  db.ts                       job records (in-memory; -> Postgres in v1)
public/environments/          v2: circuit.glb / city.glb (v0 = procedural geometry)
```

Key decoupling: the **visual mesh** (generated GLB) and the **physics rig** (chassis +
4 wheel colliders) are independent. The rig is *derived per-car* from the mesh at load time
(`lib/rig.ts`), so every car keeps its own shape yet always drives. v0 hand-authors the rig.

## Roadmap

- **v1** — real Tripo image-to-3D for the body, loaded into the scene on a derived rig.
- **v2** — sketch cleanup, part segmentation + wheel classification, real environments.
- **v3** — polish: texture quality, per-car tuning, sharing, leaderboards, credits.
