import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Build 1.13.0 — smallest viable test setup: Vitest (no separate Jest install) + jsdom (no real
// browser/Chromium binary to download, which this sandboxed environment can't reliably do) +
// @testing-library/react for component-level smoke tests + axe-core for the automated
// accessibility scan. See docs/product/BUILD-1.13.0.md, "Automated tests added" for what this
// does and doesn't cover relative to a real browser E2E suite.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    css: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "./tests/stubs/server-only.ts"),
    },
  },
});
