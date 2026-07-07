---
type: repo-overview
title: okfx
description: Developer toolkit for Open Knowledge Format bundles.
owner: NEEDS_OWNER
status: proposed
tags:
  - okf
  - developer-tooling
---

# okfx

`okfx` is a local-first developer toolkit for Open Knowledge Format bundles.
It provides validation, linting, formatting, graph inspection, semantic diff,
packaging, local indexing, MCP serving, presets, adapters, and CI/editor
integration surfaces.

## Quick start

```bash
npm install
npm run build
npm run okf -- init ./knowledge
npm run okf -- validate ./knowledge
npm run okf -- lint ./knowledge
npm run okf -- graph ./knowledge --out graph.json
npm run okf -- doctor ./knowledge
```

## Packages

- `@okfx/core` owns TypeScript bundle parsing, validation, lint, graph, format, diff, pack, index, and doctor APIs.
- `@okfx/cli` provides the `okf` command surface.
- `@okfx/mcp` exposes a read-only MCP server over stdio.
- `@okfx/plugin-api` defines plugin and adapter contracts.
- `@okfx/preset-*` packages define recommended, strict, and agent-ready rule profiles.
- `@okfx/adapter-*` packages produce reviewable OKF draft files from local metadata.

## Verification

- `npm run build`
- `npm run typecheck`
- `npm test`
- `npm audit --audit-level=moderate`
- `cargo test --workspace`
