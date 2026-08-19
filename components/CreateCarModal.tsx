"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DrawCanvas } from "./DrawCanvas";
import { PhotoPicker } from "./PhotoPicker";
import { apiGet, apiPost } from "@/lib/api";
import type { Car } from "@/lib/cars";

/**
 * CreateCarModal — hand in a car and get a 3D model back in one continuous step.
 *
 * How you hand it in depends on the device: a pointer gets the drawing canvas, a phone gets
 * the camera. Finger-drawing inside a phone-sized dialog is the worst version of both.
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
  "차대를 그리는 중…",
  "차체 패널을 찍어내는 중…",
  "바퀴를 끼우는 중…",
  "도색을 입히는 중…",
  "마지막 볼트를 조이는 중…",
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
  /**
   * Decided once on mount: this drives which input the dialog offers. The test is the
   * pointer media query, not `ontouchstart` — plenty of desktop browsers expose touch events
   * on hardware nobody draws with a finger on, and those users should still get the canvas.
   * A phone is "primary input is coarse", which is exactly what this asks.
   */
  const [touch] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches,
  );

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
      setError(touch ? "먼저 사진을 골라 주세요." : "먼저 차를 그리거나 이미지를 올려 주세요.");
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
        if (status.status === "failed") throw new Error(status.error ?? "생성에 실패했습니다");
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error("차를 만드는 데 시간이 너무 오래 걸렸습니다");
    } catch (e) {
      setError(e instanceof Error ? e.message : "문제가 발생했습니다");
      setPhase("error");
    }
  }, [onCreated, showRender, touch]);

  const working = phase === "working";

  return (
    <div className="create-car-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="create-car-dialog game-panel relative flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl text-white">
        <header className="create-car-header flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="font-heading text-lg font-bold uppercase tracking-wide">
            {phase === "draw" ? (touch ? "차 사진 올리기" : "차 그리기") : "차 만드는 중"}
          </h2>
          {!working && (
            <button
              type="button"
              onClick={onClose}
              className="touch-target flex items-center justify-center rounded-md px-2 py-1 text-[#d9c193]/70 transition hover:bg-white/10 hover:text-white"
              aria-label="닫기"
            >
              ✕
            </button>
          )}
        </header>

        <div className="create-car-body flex-1 overflow-y-auto p-5">
          {phase === "draw" && (
            <>
              {touch ? (
                <PhotoPicker onChange={(dataUrl) => (image.current = dataUrl)} />
              ) : (
                <DrawCanvas onChange={(dataUrl) => (image.current = dataUrl)} />
              )}
              {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            </>
          )}

          {working && (
            <div className="create-car-working flex flex-col items-center gap-6 py-4">
              <div className="create-car-art dmc-float">
                <div className="dmc-shimmer rounded-xl border border-white/10 bg-white/5">
                  {renderUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={renderUrl}
                      alt="완성되어 가는 내 차"
                      className="create-car-preview aspect-square w-64 rounded-xl object-contain"
                    />
                  ) : (
                    <div className="create-car-preview flex aspect-square w-64 items-center justify-center">
                      <Spinner />
                    </div>
                  )}
                </div>
              </div>

              <div className="create-car-copy w-full max-w-sm text-center">
                <p className="text-base font-medium">{STAGES[stage]}</p>
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all duration-700"
                    style={{ width: `${Math.round((progress ?? 0.08) * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-[#d9c193]/70">
                  1분 정도 걸릴 수 있어요 — 그림이 진짜 3D 모델로 바뀌는 중입니다.
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
                다시 시도
              </button>
            </div>
          )}
        </div>

        {phase === "draw" && (
          <footer className="create-car-footer flex items-center justify-end gap-3 border-t border-white/10 px-5 py-4">
            <button
              type="button"
              onClick={onClose}
              className="touch-target rounded-lg px-4 py-2 text-sm font-medium text-[#d9c193]/80 hover:bg-white/10"
            >
              취소
            </button>
            <button type="button" onClick={generate} className="btn-race px-6 py-2.5 text-sm">
              차로 만들기
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-amber-400" />
  );
}
