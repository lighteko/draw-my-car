"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { DrawCanvas } from "@/components/DrawCanvas";

type Phase =
  | "idle"
  | "submitting"
  | "generatingViews"
  | "review"
  | "buildingModel"
  | "ready"
  | "error";

interface StoredView {
  key: string;
  url: string;
}

interface JobStatus {
  jobId: string;
  status: "pending" | "processing" | "review" | "ready" | "failed";
  stage: "multiview" | "review" | "model" | null;
  carId: string;
  carUrl: string | null;
  render: StoredView | null;
  progress?: number | null;
  error?: string | null;
}

function responseError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

async function jsonOrError<T>(res: Response, label: string): Promise<T> {
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    throw new Error(responseError(body) ?? `${label} failed (${res.status})`);
  }
  return body as T;
}

export default function Home() {
  const image = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [carId, setCarId] = useState<string | null>(null);
  const [render, setRender] = useState<StoredView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollJob = useCallback(async (id: string, stopAtReview: boolean) => {
    for (let i = 0; i < 300; i++) {
      const status = await jsonOrError<JobStatus>(await fetch(`/api/jobs/${id}`), "poll");

      if (status.status === "review" && status.render) {
        setRender(status.render);
        setPhase("review");
        return;
      }

      if (status.status === "ready") {
        setCarId(status.carId);
        setPhase("ready");
        return;
      }

      if (status.status === "failed") {
        throw new Error(status.error ?? "generation failed");
      }

      setPhase(stopAtReview ? "generatingViews" : "buildingModel");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error("timed out waiting for the car");
  }, []);

  const generate = useCallback(async () => {
    if (!image.current) {
      setError("Draw or upload a car first.");
      setPhase("error");
      return;
    }

    setError(null);
    setCarId(null);
    setJobId(null);
    setRender(null);
    setPhase("submitting");

    try {
      const status = await jsonOrError<{ jobId: string }>(
        await fetch("/api/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: image.current }),
        }),
        "submit",
      );

      setJobId(status.jobId);
      setPhase("generatingViews");
      await pollJob(status.jobId, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      setPhase("error");
    }
  }, [pollJob]);

  const approveMultiview = useCallback(async () => {
    if (!jobId) return;

    setError(null);
    setPhase("buildingModel");

    try {
      await jsonOrError<JobStatus>(
        await fetch(`/api/jobs/${jobId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "approve_multiview" }),
        }),
        "start model build",
      );
      await pollJob(jobId, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      setPhase("review");
    }
  }, [jobId, pollJob]);

  const busy =
    phase === "submitting" || phase === "generatingViews" || phase === "buildingModel";

  const buttonText =
    phase === "submitting"
      ? "Generating views..."
      : phase === "generatingViews"
        ? "Generating views..."
        : phase === "buildingModel"
          ? "Building 3D..."
          : "Generate views";

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <span className="font-mono text-xs uppercase tracking-widest text-blue-600">
          Sketch-to-Drive v1
        </span>
        <h1 className="text-3xl font-bold sm:text-4xl">Draw a car. Then drive it.</h1>
        <p className="max-w-2xl text-neutral-500">
          Sketch or upload a 2D car, expand it into four consistent views, approve the
          result, then build a drivable 3D model for the physics sandbox.
        </p>
      </header>

      <div className="grid gap-8 md:grid-cols-[1fr_20rem]">
        <section>
          <DrawCanvas onChange={(dataUrl) => (image.current = dataUrl)} />
        </section>

        <aside className="flex flex-col gap-4">
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {buttonText}
          </button>

          {jobId && (
            <div className="rounded-lg border border-black/10 bg-black/[0.03] p-3 font-mono text-xs dark:border-white/10 dark:bg-white/[0.03]">
              <div className="text-neutral-500">job</div>
              <div className="break-all">{jobId}</div>
            </div>
          )}

          {phase === "review" && render && (
            <div className="rounded-lg border border-black/10 bg-black/[0.03] p-3 dark:border-white/10 dark:bg-white/[0.03]">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">3D render preview</h2>
                <span className="text-xs text-neutral-500">review</span>
              </div>
              <figure className="overflow-hidden rounded-md bg-white dark:bg-black">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={render.url}
                  alt="generated 3D render"
                  className="aspect-square w-full object-contain"
                />
              </figure>
              <button
                type="button"
                onClick={approveMultiview}
                disabled={busy}
                className="mt-3 w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Build 3D model
              </button>
            </div>
          )}

          {phase === "ready" && carId && (
            <Link
              href={`/simulate/${carId}`}
              className="rounded-lg bg-emerald-600 px-4 py-3 text-center font-semibold text-white shadow-sm transition hover:bg-emerald-500"
            >
              Drive it
            </Link>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="mt-2 border-t border-black/10 pt-4 dark:border-white/10">
            <p className="mb-2 text-xs text-neutral-500">Skip the pipeline:</p>
            <Link
              href="/simulate/placeholder"
              className="inline-block rounded-lg border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
            >
              Drive the placeholder
            </Link>
          </div>
        </aside>
      </div>
    </main>
  );
}
