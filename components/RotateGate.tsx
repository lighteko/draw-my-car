"use client";

import { useEffect, useState } from "react";

/**
 * RotateGate — the phone-in-portrait blocker.
 *
 * This is a racing game: every screen is laid out for a wide viewport, and the drive itself
 * puts steering on the left and pedals on the right. The manifest asks for landscape, but a
 * browser tab cannot be forced, so portrait gets an overlay instead of a broken layout.
 *
 * Only phones are gated. Desktops with a narrow window and tablets held upright still have
 * room to work with, so the test is coarse pointer + portrait + a short viewport.
 */

const MAX_PHONE_LANDSCAPE_WIDTH = 1024;

function isPortraitPhone(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const portrait = window.innerHeight > window.innerWidth;
  const phoneSized = Math.min(window.innerWidth, window.innerHeight) < MAX_PHONE_LANDSCAPE_WIDTH;
  return coarse && portrait && phoneSized;
}

export function RotateGate() {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const update = () => setBlocked(isPortraitPhone());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  if (!blocked) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 bg-[#17110b] px-8 text-center">
      <span className="animate-pulse text-6xl" aria-hidden>
        📱
      </span>
      <div>
        <p className="font-display text-2xl text-amber-300">화면을 가로로 돌려주세요</p>
        <p className="mt-2 text-sm text-white/55">
          가로 화면에서 조작하도록 만들어진 레이싱 게임입니다.
        </p>
      </div>
      <p className="font-mono text-[11px] text-white/35">
        홈 화면에 추가하면 전체 화면으로 실행됩니다
      </p>
    </div>
  );
}
