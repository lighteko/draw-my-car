import type { MetadataRoute } from "next";

/**
 * Web app manifest — this is what makes the game launch as an app rather than a tab.
 *
 * `display: "standalone"` rather than `"fullscreen"` on purpose: fullscreen is Android-only
 * and is ignored on iOS, while standalone is honoured by both (iOS needs it together with the
 * apple-mobile-web-app-capable meta the layout already sets). Installed from the home screen,
 * that removes the browser chrome the phone layout was fighting for space with.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AI 바이블 드라이브",
    short_name: "바이블 드라이브",
    description: "차를 그리고, 여리고 성벽을 달리세요.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "landscape",
    background_color: "#17110b",
    theme_color: "#17110b",
    lang: "ko",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
