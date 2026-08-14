import { ImageResponse } from "next/og";

/** iOS home-screen tile. Same art as the app icon, at the size Apple asks for. */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
          fontSize: 110,
          fontWeight: 700,
        }}
      >
        🏁
      </div>
    ),
    size,
  );
}
