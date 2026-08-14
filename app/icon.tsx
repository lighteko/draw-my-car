import { ImageResponse } from "next/og";

/**
 * Generated at build time so the install prompt has an icon without shipping binary assets.
 * Desert palette, so the home-screen tile matches the game it opens.
 */
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(160deg, #3b2a19 0%, #17110b 70%)",
          color: "#e0a84e",
          fontSize: 300,
          fontWeight: 700,
        }}
      >
        🏁
      </div>
    ),
    size,
  );
}
