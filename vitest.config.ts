import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@pi-remote/protocol": source("./packages/protocol/src/index.ts"),
      "@pi-remote/e2e": source("./packages/e2e/src/index.ts"),
      "@pi-remote/host": source("./packages/host/src/index.ts"),
      "@pi-remote/runtime-bridge": source("./packages/runtime-bridge/src/index.ts"),
      "@pi-remote/interaction-sdk": source("./packages/remote-interaction-sdk/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 10_000,
  },
});
