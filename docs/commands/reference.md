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
| `okf graph` | Build graph JSON, DOT, HTML, or Cytoscape elements. |
| `okf doctor` | Compute agent-readiness diagnostics and score. |
| `okf diff` | Compare two bundles semantically. |
| `okf pack` | Write `.okfx` metadata and `.okf.tar.gz` archive. |
| `okf index` | Build a deterministic local full-text index. |
| `okf export` | Export reviewable consumer files such as a static site. |
| `okf mcp` | Run a read-only stdio MCP server. |

`okf graph --format json` emits `markdown-link`, `resource`, and `tag` edges.
Graph analysis such as backlinks, orphan concepts, and cycles is computed from
resolved concept-to-concept links.

## Editor Surface

The VS Code extension exposes diagnostics, formatting, frontmatter and link
completion, go-to-definition, graph preview, doctor panel, backlinks panel, and
quick fixes for common missing frontmatter diagnostics.

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
