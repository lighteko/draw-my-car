import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate config for the e2e suite (real dev server + real Supabase). Run via `npm run test:e2e`.
// Not picked up by the default `npx vitest run` — see the root vitest.config.mts `exclude`.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("..", import.meta.url)),
    },
  },
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 30_000,
  },
});
