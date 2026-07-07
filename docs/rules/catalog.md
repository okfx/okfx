---
type: contract
title: okfx Rule Catalog
description: Built-in rule categories and diagnostic behavior.
owner: NEEDS_OWNER
status: proposed
tags:
  - rules
  - diagnostics
---

# okfx Rule Catalog

## Categories

- `spec/*`: OKF conformance failures.
- `hygiene/*`: maintainability and content quality.
- `graph/*`: link resolution, backlinks, or topology issues.
- `style/*`: stable formatting and naming conventions.
- `agent/*`: agent-readiness and production context checks.
- `security/*`: suspicious secrets and resource policy issues.

## Failure Threshold

Config `failOn` controls whether `warning`, `advice`, or only `error` diagnostics
fail command execution. The `strict` preset sets `failOn: warning`.

## Verification

- Core rule tests under `packages/core/test/lint.test.ts`.
- Doctor tests under `packages/core/test/doctor.test.ts`.
