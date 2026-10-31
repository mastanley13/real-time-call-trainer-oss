import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // "server-only" throws outside a React Server Component bundle; tests run server modules directly.
      "server-only": path.resolve(__dirname, "tests/server-only-stub.ts"),
    },
  },
  // tsconfig keeps "jsx": "preserve" for Next; component tests need the automatic runtime.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
