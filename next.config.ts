import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A second loopback origin is useful for real two-device multiplayer smoke tests: it
  // gets its own localStorage identity while still hitting the same local server.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
