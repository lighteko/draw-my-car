import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // The e2e suite needs a running dev server and real Supabase credentials; it has its own
    // config/script (see e2e/vitest.config.mts, `npm run test:e2e`) and must stay out of the
    // default offline run.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
