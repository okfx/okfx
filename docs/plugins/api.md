---
type: contract
title: okfx Plugin API
description: Public plugin shape and executable-code trust boundary.
owner: okfx-maintainers
status: proposed
tags:
  - plugins
  - api
---

# okfx Plugin API

## Boundary

Plugins receive stable JSON IR such as `BundleIR`, `GraphIR`, `DiagnosticIR`,
and `ResolvedOkfxConfig`. They MUST NOT depend on internal Rust structs.

## Trust Model

Plugins are executable code. A user SHOULD only enable plugins from trusted
packages or reviewed local source.

Plugins are explicit. A bundle must list plugin packages in `okfx.config.*`, and
CLI users can disable configured plugins with `okf lint --no-plugins`.

## Extension Points

- Rules
- Producer adapters
- Consumer adapters
- MCP tool definitions

## Package Shape

```ts
import { definePlugin } from "@okfx/plugin-api";

export default definePlugin({
  name: "@acme/okfx-plugin-data-platform",
  version: "0.1.0",
  rules: {
    "acme/owner-required": {
      meta: {
        description: "Concepts must declare an owner.",
        defaultSeverity: "warning"
      },
      run({ bundle }) {
        return bundle.concepts
          .filter((concept) => typeof concept.frontmatter.owner !== "string")
          .map((concept) => ({
            code: "acme/owner-required",
            severity: "warning",
            message: "Concept should declare an owner.",
            path: concept.path,
            conceptId: concept.id
          }));
      }
    }
  }
});
```

## Config

```ts
export default {
  plugins: [
    "@acme/okfx-plugin-data-platform",
    {
      package: "./local-plugin.ts",
      options: {
        requiredOwner: "data-platform"
      }
    }
  ]
};
```

If a configured plugin cannot be loaded, `okf lint` emits a `plugin/load-failed`
error diagnostic.

## Verification

- Type surface: `packages/plugin-api/src/index.ts`.
- Build gate: `npm run typecheck`.
