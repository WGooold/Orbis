import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@orbis/protocol": source("./packages/protocol/src/index.ts"),
      "@orbis/e2e": source("./packages/e2e/src/index.ts"),
      "@orbis/host": source("./packages/host/src/index.ts"),
      "@orbis/relay": source("./packages/relay/src/index.ts"),
      "@orbis/runtime-bridge": source("./packages/runtime-bridge/src/index.ts"),
      "@orbis/interaction-sdk": source("./packages/remote-interaction-sdk/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 10_000,
  },
});
