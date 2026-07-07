---
type: contract
title: okfx Rule Catalog
description: Built-in rule categories and diagnostic behavior.
owner: okfx-maintainers
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

## Security Rules

- `security/suspicious-secret`: aggregate error for private keys and token-looking values.
- `security/private-key`: private key material appears in frontmatter or body content.
- `security/token-looking-value`: API key, secret, token, or AWS access-key shaped value appears in content.
- `security/unredacted-email`: raw email address appears in frontmatter or body content.
- `security/internal-url`: private or local URL appears in frontmatter or body content.
- `security/private-url`: `resource` points to a private or local host.
- `security/non-allowlisted-resource`: `resource` host is outside `resourcePolicy.allowHosts`.

## Failure Threshold

Config `failOn` controls whether `warning`, `advice`, or only `error` diagnostics
fail command execution. The `strict` preset sets `failOn: warning`.

## Verification

- Core rule tests under `packages/core/test/lint.test.ts`.
- Doctor tests under `packages/core/test/doctor.test.ts`.
