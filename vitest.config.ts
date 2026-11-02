import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Next compiles components with the automatic JSX runtime; tests that call a component directly need the same.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // "server-only" throws outside a React Server Component bundle; tests run server modules directly.
      "server-only": path.resolve(__dirname, "tests/server-only-stub.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
