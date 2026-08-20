import type { Metadata, Viewport } from "next";
import { Black_Han_Sans, Geist_Mono, Noto_Sans_KR } from "next/font/google";
import "./globals.css";
import { RotateGate } from "@/components/RotateGate";
import { SuppressContextMenu } from "@/components/SuppressContextMenu";

// Korean-first body face — the UI is entirely in Korean, so Latin-only faces would leave
// every label to a system fallback.
const notoSansKr = Noto_Sans_KR({
  variable: "--font-sans-kr",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Heavy poster face for titles/menus — carries the desert-fortress look, and unlike the old
// condensed Latin face it actually has Hangul.
const blackHanSans = Black_Han_Sans({
  variable: "--font-heading-kr",
  subsets: ["latin"],
  weight: ["400"],
});

export const metadata: Metadata = {
  title: "AI 바이블 드라이브",
  description: "차를 그리고, 여리고 성벽을 달리세요.",
  // Launch fullscreen when added to the home screen (esp. iOS, which lacks the FS API).
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AI 바이블 드라이브",
  },
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#17110b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${notoSansKr.variable} ${geistMono.variable} ${blackHanSans.variable} h-full antialiased`}
    >
      <body className="min-h-dvh">
        {children}
        <RotateGate />
        <SuppressContextMenu />
      </body>
    </html>
  );
}
