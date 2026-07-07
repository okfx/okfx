---
type: test-plan
title: okfx Testing Strategy
description: Verification commands and fixture strategy for okfx.
owner: NEEDS_OWNER
status: proposed
tags:
  - testing
  - verification
---

# okfx Testing Strategy

## Required Commands

- `npm run build`
- `npm run typecheck`
- `npm test`
- `npm audit --audit-level=moderate`
- `cargo test --workspace`

## Fixture Coverage

Fixtures cover valid bundles, invalid validation cases, lint cases, formatter
golden inputs, graph topology, and semantic diff behavior.

## Performance Baselines

`packages/core/test/performance.test.ts` generates large synthetic bundles during
test execution. It covers high concept counts, dense link graphs, search index
construction, and many-diagnostic lint runs with conservative time budgets.

## Verification

Current unit and integration tests are under `packages/*/test/`. Fixture
directories under `fixtures/` are intended for future golden-file expansion.
