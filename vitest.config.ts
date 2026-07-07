import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@okfx/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@okfx/mcp": fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
      "@okfx/adapter-markdown": fileURLToPath(new URL("./packages/adapter-markdown/src/index.ts", import.meta.url)),
      "@okfx/adapter-openapi": fileURLToPath(new URL("./packages/adapter-openapi/src/index.ts", import.meta.url)),
      "@okfx/adapter-dbt": fileURLToPath(new URL("./packages/adapter-dbt/src/index.ts", import.meta.url)),
      "@okfx/adapter-datahub": fileURLToPath(new URL("./packages/adapter-datahub/src/index.ts", import.meta.url)),
      "@okfx/adapter-bigquery": fileURLToPath(new URL("./packages/adapter-bigquery/src/index.ts", import.meta.url))
    }
  }
});
