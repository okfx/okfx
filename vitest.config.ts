import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@okfx/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@okfx/mcp": fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url))
    }
  }
});
