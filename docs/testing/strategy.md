---
type: test-plan
title: okfx Testing Strategy
description: Verification commands and fixture strategy for okfx.
tags:
  - testing
  - verification
owner: okfx-maintainers
status: proposed
---

# okfx Testing Strategy

## Required Commands

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm audit --audit-level moderate`
- `pnpm check:okf`
- `pnpm check:rust`
- `cargo test --workspace`
- `cargo build -p okfx_wasm --target wasm32-unknown-unknown`
- `cargo build -p okfx_cli --release`

`check:okf` validates, lints, and format-checks the documentation bundle and each
example bundle independently, so unrelated examples cannot mask or create duplicate
concept diagnostics. `check:rust` enforces rustfmt and treats every Clippy warning as
an error. Both CI and release verification run these gates.

## Fixture Coverage

Fixtures cover valid bundles, invalid validation cases, lint cases, formatter
golden inputs, graph topology, and semantic diff behavior.

## Performance Baselines

`packages/core/test/performance.test.ts` generates large synthetic bundles during
test execution. It covers high concept counts, dense link graphs, search index
construction, and many-diagnostic lint runs with conservative time budgets.

## Fuzzing

Parser and resolver fuzz targets live under `fuzz/`. Use `cargo fuzz run parser`
or `cargo fuzz run resolver` for exploratory hardening. Stable regression cases
from fuzzing and edge-case analysis are promoted into
`crates/okfx_parser/tests/fuzz_regression.rs`.

## Verification

Current unit and integration tests are under `packages/*/test/`. Fixture
directories under `fixtures/` are intended for future golden-file expansion.
