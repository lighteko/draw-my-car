"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * DrawCanvas — draw or upload a 2D car.
 *
 * Self-contained drawing surface (HTML5 canvas) with freehand drawing + image upload.
 * It exports the current picture as a PNG data URL via `onChange`, fired on stroke-end
 * and on upload (not on every pointer move). In v1 this PNG is what we send to the
 * provider for image-to-3D.
 */

const WIDTH = 640;
const HEIGHT = 448;

export function DrawCanvas({
  onChange,
  className,
}: {
  onChange?: (dataUrl: string | null) => void;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasContent, setHasContent] = useState(false);
  const [brush, setBrush] = useState(6);

  const ctx = useCallback(() => canvasRef.current?.getContext("2d") ?? null, []);

  const paintBackground = useCallback(() => {
    const c = ctx();
    if (!c) return;
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, WIDTH, HEIGHT);
  }, [ctx]);

  // Paint a clean white background once mounted (no state change in the effect).
  useEffect(() => {
    paintBackground();
  }, [paintBackground]);

  const clear = () => {
    paintBackground();
    setHasContent(false);
    onChange?.(null);
  };

  const exportImage = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onChange?.(canvas.toDataURL("image/png"));
  }, [onChange]);

  const pointerPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * HEIGHT,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pointerPos(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const c = ctx();
    if (!c) return;
    const p = pointerPos(e);
    const from = last.current ?? p;
    c.strokeStyle = "#111827";
    c.lineWidth = brush;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.lineTo(p.x, p.y);
    c.stroke();
    last.current = p;
    setHasContent(true);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    exportImage();
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = ctx();
      if (c) {
        c.fillStyle = "#ffffff";
        c.fillRect(0, 0, WIDTH, HEIGHT);
        // Fit the image inside the canvas (contain).
        const scale = Math.min(WIDTH / img.width, HEIGHT / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        c.drawImage(img, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
        setHasContent(true);
        exportImage();
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
    e.target.value = ""; // allow re-uploading the same file
  };

  return (
    <div className={className}>
      <div className="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm dark:border-white/15">
        <canvas
          ref={canvasRef}
          width={WIDTH}
          height={HEIGHT}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          className="block aspect-[10/7] w-full touch-none cursor-crosshair"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          onClick={clear}
          className="rounded-md border border-black/15 px-3 py-1.5 font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          Clear
        </button>

        <label className="cursor-pointer rounded-md border border-black/15 px-3 py-1.5 font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
          Upload image
          <input type="file" accept="image/*" onChange={onUpload} className="hidden" />
        </label>

        <label className="flex items-center gap-2 text-neutral-500">
          Brush
          <input
            type="range"
            min={2}
            max={24}
            value={brush}
            onChange={(e) => setBrush(Number(e.target.value))}
          />
        </label>

        <span className="ml-auto text-xs text-neutral-400">
          {hasContent ? "ready to generate" : "draw or upload a car"}
        </span>
      </div>
    </div>
  );
}
