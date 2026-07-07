---
type: contract
title: okf Command Reference
description: Stable CLI command behavior and exit-code contract.
owner: okfx-maintainers
status: proposed
tags:
  - cli
  - commands
---

# okf Command Reference

## Commands

| Command | Purpose |
| --- | --- |
| `okf init` | Create a starter OKF bundle. |
| `okf validate` | Check hard OKF conformance. |
| `okf lint` | Run quality, graph, style, and security rules. |
| `okf fmt` | Format Markdown and YAML frontmatter conservatively. |
| `okf graph` | Build graph JSON, DOT, or HTML. |
| `okf doctor` | Compute agent-readiness diagnostics and score. |
| `okf diff` | Compare two bundles semantically. |
| `okf pack` | Write `.okfx` metadata and `.okf.tar.gz` archive. |
| `okf index` | Build a deterministic local full-text index. |
| `okf export` | Export reviewable consumer files such as a static site. |
| `okf mcp` | Run a read-only stdio MCP server. |

## Plugin Safety

`okf lint` loads plugins declared in `okfx.config.*`. Use
`okf lint --no-plugins` to run only built-in validation and lint rules.

## OKF Version

`okf validate --okf-version 0.1` overrides the configured OKF compatibility
version for one run. Unsupported versions produce
`spec/unsupported-okf-version`.

## Exit Codes

- `0`: command completed and did not cross its failure threshold.
- `1`: diagnostics, diff changes, or format check differences crossed the command threshold.
- `2`: runtime/config/argument failure.

## Verification

- CLI integration tests under `packages/cli/test/`.
- Manual smoke command: `npm run okf -- --help`.
