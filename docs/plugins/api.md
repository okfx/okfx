---
type: contract
title: okfx Plugin API
description: Public plugin shape and executable-code trust boundary.
owner: NEEDS_OWNER
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

## Extension Points

- Rules
- Producer adapters
- Consumer adapters
- MCP tool definitions

## Verification

- Type surface: `packages/plugin-api/src/index.ts`.
- Build gate: `npm run typecheck`.
