"use client";

import { useCallback, useRef, useState } from "react";

/**
 * PhotoPicker — the phone's way into car creation.
 *
 * Drawing a car with a finger in the ~300×200 box a phone dialog can spare is miserable, so
 * touch devices take a photo instead. Two inputs rather than one: `capture="environment"`
 * jumps straight to the camera on Android, which also means that input can no longer reach
 * the gallery — so the gallery gets its own button next to it.
 *
 * The picked image is downscaled before it leaves the device: phone cameras produce multi-
 * megabyte shots, and the generator only needs a reasonable square.
 */

const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

async function toDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이미지를 처리할 수 없습니다");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

export function PhotoPicker({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(null);
      try {
        const dataUrl = await toDataUrl(file);
        setPreview(dataUrl);
        onChange(dataUrl);
      } catch {
        setError("사진을 불러오지 못했습니다. 다른 사진으로 시도해 주세요.");
        onChange(null);
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-2xl border border-dashed border-white/20 bg-black/30">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="선택한 사진" className="h-full w-full object-contain" />
        ) : (
          <span className="px-6 text-center text-sm text-white/45">
            {busy ? "사진 불러오는 중…" : "차 사진을 찍거나 앨범에서 골라주세요"}
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => cameraRef.current?.click()}
          className="btn-race min-h-12 flex-1 px-4 text-sm"
        >
          📷 사진 찍기
        </button>
        <button
          type="button"
          onClick={() => galleryRef.current?.click()}
          className="btn-ghost min-h-12 flex-1 px-4 text-sm"
        >
          🖼️ 앨범에서 고르기
        </button>
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void accept(event.target.files?.[0])}
        className="sr-only"
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        onChange={(event) => void accept(event.target.files?.[0])}
        className="sr-only"
      />
    </div>
  );
}
