"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DrawCanvas } from "./DrawCanvas";
import { apiGet, apiPost } from "@/lib/api";
import type { Car } from "@/lib/cars";

/**
 * CreateCarModal — draw a car and get a 3D model back in one continuous step.
 *
 * The two-stage pipeline (render, then build) is hidden: as soon as the fast 3/4 render
 * comes back we show it as *living loading art* (a floating, shimmering preview with
 * staged copy) and auto-approve the model build behind it. No manual "approve" step.
 */

type Phase = "draw" | "working" | "error";

interface JobCreateResponse {
  jobId: string;
  status: string;
  render: { key: string; url: string } | null;
}

interface JobStatusResponse {
  status: string;
  carUrl: string | null;
  render: { key: string; url: string } | null;
  progress: number | null;
  error: string | null;
}

const STAGES = [
  "Sketching the chassis…",
  "Pressing the body panels…",
  "Mounting the wheels…",
  "Spraying a fresh coat…",
  "Tightening the last bolts…",
];

export function CreateCarModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (car: Car) => void;
}) {
  const image = useRef<string | null>(null);
  const renderUrlRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("draw");
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState(0);

  // Cycle the staged copy while the model builds.
  useEffect(() => {
    if (phase !== "working") return;
    const t = setInterval(() => setStage((i) => (i + 1) % STAGES.length), 2600);
    return () => clearInterval(t);
  }, [phase]);

  const showRender = useCallback((url: string | null | undefined) => {
    if (url && !renderUrlRef.current) {
      renderUrlRef.current = url;
      setRenderUrl(url);
    }
  }, []);

  const generate = useCallback(async () => {
    if (!image.current) {
      setError("Draw or upload a car first.");
      return;
    }
    setError(null);
    setStage(0);
    setProgress(null);
    setRenderUrl(null);
    renderUrlRef.current = null;
    setPhase("working");

    try {
      // 1. Fast 3/4 render — becomes the loading art.
      const created = await apiPost<JobCreateResponse>("/api/jobs", { image: image.current });
      showRender(created.render?.url);

      // 2. Auto-chain the 3D build (no manual approval surfaced to the user).
      await apiPost(`/api/jobs/${created.jobId}`, { action: "approve_multiview" });

      // 3. Poll until the model is ready, then persist it as a car.
      for (let i = 0; i < 300; i++) {
        const status = await apiGet<JobStatusResponse>(`/api/jobs/${created.jobId}`);
        showRender(status.render?.url);
        setProgress(status.progress ?? null);

        if (status.status === "ready") {
          const { car } = await apiPost<{ car: Car }>("/api/cars", { jobId: created.jobId });
          onCreated(car);
          return;
        }
        if (status.status === "failed") throw new Error(status.error ?? "generation failed");
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error("timed out building your car");
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      setPhase("error");
    }
  }, [onCreated, showRender]);

  const working = phase === "working";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="game-panel relative flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl text-white">
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="font-heading text-lg font-bold uppercase tracking-wide">
            {phase === "draw" ? "Draw your car" : "Building your car"}
          </h2>
          {!working && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-neutral-400 transition hover:bg-white/10 hover:text-white"
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {phase === "draw" && (
            <>
              <DrawCanvas onChange={(dataUrl) => (image.current = dataUrl)} />
              {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            </>
          )}

          {working && (
            <div className="flex flex-col items-center gap-6 py-4">
              <div className="dmc-float">
                <div className="dmc-shimmer rounded-xl border border-white/10 bg-white/5">
                  {renderUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={renderUrl}
                      alt="your car coming to life"
                      className="aspect-square w-64 rounded-xl object-contain"
                    />
                  ) : (
                    <div className="flex aspect-square w-64 items-center justify-center">
                      <Spinner />
                    </div>
                  )}
                </div>
              </div>

              <div className="w-full max-w-sm text-center">
                <p className="text-base font-medium">{STAGES[stage]}</p>
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-cyan-500 transition-all duration-700"
                    style={{ width: `${Math.round((progress ?? 0.08) * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-neutral-400">
                  This can take a minute — your sketch is turning into a real 3D model.
                </p>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <p className="text-sm text-red-400">{error}</p>
              <button
                type="button"
                onClick={() => setPhase("draw")}
                className="rounded-lg border border-white/20 px-4 py-2 text-sm font-medium hover:bg-white/10"
              >
                Try again
              </button>
            </div>
          )}
        </div>

        {phase === "draw" && (
          <footer className="flex items-center justify-end gap-3 border-t border-white/10 px-5 py-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-300 hover:bg-white/10"
            >
              Cancel
            </button>
            <button type="button" onClick={generate} className="btn-race px-6 py-2.5 text-sm">
              Bring it to life
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-cyan-400" />
  );
}
