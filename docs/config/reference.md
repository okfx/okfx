---
type: contract
title: okfx Configuration
description: Config file names, presets, rule overrides, and resource policy.
owner: NEEDS_OWNER
status: proposed
tags:
  - config
  - presets
---

# okfx Configuration

## Files

`okfx` loads `okfx.config.ts`, `okfx.config.mts`, `okfx.config.mjs`,
`okfx.config.js`, `okfx.config.cjs`, or `okfx.config.json` from the bundle root.

## Presets

- `recommended`: balanced defaults.
- `strict`: CI-oriented warning threshold and stricter severities.
- `agent-ready`: agent-readiness diagnostics.

## Resource Policy

`resourcePolicy.allowHosts` restricts resource URLs when configured. No network
request is made to verify resources.

## Verification

- Config loading tests under `packages/core/test/bundle.test.ts`.
- Preset expansion tests under `packages/core/test/bundle.test.ts`.
