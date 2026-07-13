---
type: contract
title: okfx Configuration
description: Config file names, presets, rule overrides, and resource policy.
tags:
  - config
  - presets
owner: okfx-maintainers
status: proposed
---

# okfx Configuration

## Files

`okfx` loads `okfx.config.ts`, `okfx.config.mts`, `okfx.config.mjs`,
`okfx.config.js`, `okfx.config.cjs`, or `okfx.config.json` from the bundle root.

## Presets

- `recommended`: balanced defaults.
- `strict`: CI-oriented warning threshold and stricter severities.
- `agent-ready`: agent-readiness diagnostics.

Unknown preset names are configuration errors. `agent-ready` enables its rules
for `okf lint`; `okf doctor` enables the same readiness rules by default while
still honoring explicit rule levels and `off` overrides.

## OKF Version

`okfVersion` defaults to `0.1`. Unsupported versions are reported by
`okf validate` as `spec/unsupported-okf-version`; use
`okf validate --okf-version 0.1` to override the config value for a single run.

## Resource Policy

`resourcePolicy.allowHosts` restricts resource URLs when configured. No network
request is made to verify resources.

## Plugins

`plugins` is an explicit allowlist of executable plugin modules. Entries can be
package specifiers or objects with package, enabled, and options fields.

```ts
export default {
  plugins: [
    "@acme/okfx-plugin",
    {
      package: "./local-plugin.ts",
      enabled: true,
      options: {
        requiredOwner: "data-platform"
      }
    }
  ]
};
```

Use `okf lint --no-plugins` to disable configured plugins for one run.

MCP and VS Code diagnostics load the same config and configured lint plugins as
the CLI. `mcp.exposeGraph` and `mcp.exposeDiagnostics` control which MCP
resources and tools are registered.

## Verification

- Config loading tests under `packages/core/test/bundle.test.ts`.
- Preset expansion tests under `packages/core/test/bundle.test.ts`.
