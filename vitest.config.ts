import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@okfxjs/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@okfxjs/mcp": fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
      "@okfxjs/adapter-markdown": fileURLToPath(new URL("./packages/adapter-markdown/src/index.ts", import.meta.url)),
      "@okfxjs/adapter-openapi": fileURLToPath(new URL("./packages/adapter-openapi/src/index.ts", import.meta.url)),
      "@okfxjs/adapter-dbt": fileURLToPath(new URL("./packages/adapter-dbt/src/index.ts", import.meta.url)),
      "@okfxjs/adapter-datahub": fileURLToPath(new URL("./packages/adapter-datahub/src/index.ts", import.meta.url)),
      "@okfxjs/adapter-bigquery": fileURLToPath(new URL("./packages/adapter-bigquery/src/index.ts", import.meta.url))
    }
  }
});
