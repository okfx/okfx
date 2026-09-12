# okfx

> The developer toolkit for **Open Knowledge Format (OKF)** bundles.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-11.8.0-orange.svg)](https://pnpm.io)
[![Built with](https://img.shields.io/badge/built%20with-Rust%20%2B%20TypeScript-blue.svg)](#architecture)

`okfx` validates, lints, formats, graphs, diffs, packages, indexes, and serves OKF
bundles to humans, CI systems, and AI agents. Its default command is `okf`, and its
packages live under the `@okfxjs/*` namespace.

Think of it as:

> **ESLint + Prettier + ripgrep + graph inspector + package verifier + MCP gateway** for
> Markdown-based knowledge bundles.

`okfx` does **not** try to redefine the OKF standard or replace a data catalog. It gives
teams an engineering workflow around OKF bundles:

```text
author → validate → lint → format → graph → review → diff → pack → index → serve to agents
```

---

## Table of contents

- [What is an OKF bundle?](#what-is-an-okf-bundle)
- [Features](#features)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [Diagnostics model](#diagnostics-model)
- [MCP server](#mcp-server)
- [GitHub Action](#github-action)
- [Adapters (import / export)](#adapters-import--export)
- [Editor integration](#editor-integration)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Project status](#project-status)
- [Contributing](#contributing)
- [License](#license)

---

## What is an OKF bundle?

Open Knowledge Format is an intentionally lightweight format for exchanging knowledge
context between humans, tools, catalogs, and agents. A bundle is just a directory tree:

```text
knowledge/
  index.md                 # reserved: navigable entrypoint
  log.md                   # reserved: change log
  metrics/
    weekly_active_users.md # a concept
  tables/
    user_events.md         # a concept
  okfx.config.ts           # okfx configuration (optional)
```

The core conventions:

- A **bundle** is a directory of Markdown files.
- A **concept** is a Markdown file with a YAML frontmatter block.
- The file path is the concept identity (e.g. `metrics/weekly_active_users`).
- Markdown links express relationships between concepts.
- `index.md` and `log.md` are reserved filenames.
- `type` is the single most important required frontmatter field.

A minimal concept:

```md
---
type: Metric
title: Weekly Active Users
description: Number of unique users active in the last 7 days.
resource: https://docs.example.com/metrics/wau
tags:
  - analytics
  - engagement
timestamp: 2026-07-07T00:00:00Z
---

# Weekly Active Users

Weekly Active Users measures unique users who performed a qualifying event in the last 7 days.

## Source Tables

- [User Events](../tables/user_events.md)
```

---

## Features

| Capability | Command | Description |
| --- | --- | --- |
| **Validate** | `okf validate` | Hard OKF conformance: parseable frontmatter, non-empty `type`, valid paths, reserved filenames, supported OKF version. |
| **Lint** | `okf lint` | Opinionated quality, hygiene, graph, style, and security rules with configurable severities. |
| **Format** | `okf fmt` | Conservative, deterministic formatting of YAML frontmatter and Markdown (`--check` for CI). |
| **Graph** | `okf graph` | Concept graph with backlinks, orphans, cycles, hubs, and stale-subgraph analysis. Exports JSON, DOT, HTML, or Cytoscape. |
| **Doctor** | `okf doctor` | Agent-readiness and production checks with a 0–100 readiness score. |
| **Diff** | `okf diff` | Semantic diff of two bundles: added/removed/renamed/changed concepts, link changes, and readiness delta. |
| **Pack** | `okf pack` | Portable, verifiable artifact with `manifest.json`, `checksums.json`, `provenance.json`, and a `.okf.tar.gz`. |
| **Index** | `okf index` | Deterministic local full-text search index (vector/hybrid modes are opt-in). |
| **Import** | `okf import` | Produce reviewable OKF draft files from Markdown, OpenAPI, dbt, DataHub, or BigQuery metadata. |
| **Export** | `okf export` | Export a bundle to a consumer surface such as a static site. |
| **MCP** | `okf mcp` | Serve a bundle to AI agents over the Model Context Protocol (read-only by default). |

Design principles: **local-first** (no network, no telemetry, no LLM calls by default),
**deterministic** (stable sorting, hashes, diagnostics, and IDs for reliable CI and diffs),
and **spec-compatible but opinionated** (a clear split between spec errors, lint warnings,
and doctor advice).

---

## Quick start

### Requirements

- [Node.js](https://nodejs.org) `>= 20`
- [pnpm](https://pnpm.io) `11.8.0` (for local development of this repo)

### Install the CLI

```bash
pnpm add -g okfx
# or run without installing
pnpm dlx okfx --help
```

### Create and check a bundle

```bash
# scaffold a starter bundle (templates: minimal, data-platform, api-catalog, metrics)
okf init ./knowledge --template data-platform

# hard conformance check
okf validate ./knowledge

# quality, graph, style, and security rules
okf lint ./knowledge

# agent-readiness score and production checks
okf doctor ./knowledge

# build the concept graph
okf graph ./knowledge --format json --out graph.json
```

Example `okf doctor` output:

```text
OKF Doctor

Bundle:
  root: /path/to/knowledge
  concepts: 2
  links: 2
  broken links: 0
  orphan concepts: 0
  cycles: 0
  failOn: error

Agent readiness:
  score: 94/100
  errors: 0
  warnings: 0
  advice: 2
```

---

## Commands

All commands accept a bundle root (default `.`). Full behavior and exit codes are
documented in [`docs/commands/reference.md`](./docs/commands/reference.md).

| Command | Purpose | Notable options |
| --- | --- | --- |
| `okf init [bundle]` | Create a starter OKF bundle | `--template <name>`, `--force` |
| `okf validate [bundle]` | Check hard OKF conformance | `--format pretty\|json`, `--json`, `--out`, `--okf-version` |
| `okf lint [bundle]` | Run quality and style rules | `--format pretty\|json\|sarif`, `--no-plugins`, `--debug`, `--timings` |
| `okf fmt [bundle]` | Format Markdown and frontmatter | `--check` |
| `okf graph [bundle]` | Build the concept graph | `--format json\|dot\|html\|cytoscape`, `--out` |
| `okf doctor [bundle]` | Agent-readiness diagnostics + score | `--json`, `--out` |
| `okf diff <before> <after>` | Compare two bundles semantically | `--format pretty\|json\|markdown` |
| `okf pack [bundle]` | Create a portable bundle artifact | `--out`, `--name`, `--json` |
| `okf index [bundle]` | Build a local search index | `--mode full-text\|vector\|hybrid`, `--vector-provider`, `--out` |
| `okf import <adapter>` | Produce reviewable OKF drafts | `--input`, `--out`, `--write`, `--dry-run` |
| `okf export <target> [bundle]` | Export to a consumer surface | `--out`, `--write`, `--dry-run` |
| `okf mcp [bundle]` | Run a read-only MCP server | `--readonly`, `--allow-write`, `--describe` |

---

## Configuration

`okfx` loads the first config file it finds in the bundle root: `okfx.config.ts`,
`.mts`, `.mjs`, `.js`, `.cjs`, or `.json`. Full reference:
[`docs/config/reference.md`](./docs/config/reference.md).

```ts
import { defineConfig } from "@okfxjs/core";

export default defineConfig({
  okfVersion: "0.1",

  include: ["**/*.md"],
  exclude: ["node_modules/**", ".git/**", ".okfx/**", "dist/**"],

  presets: ["recommended", "agent-ready"],

  rules: {
    "spec/missing-type": "error",
    "hygiene/missing-description": "warning",
    "graph/broken-internal-link": "warning",
    "graph/orphan-concept": "advice",
    "agent/metric-missing-source": "warning",
    "security/suspicious-secret": "error"
  },

  // fail the command when a diagnostic reaches this severity
  failOn: "error",

  frontmatter: {
    keyOrder: ["type", "title", "description", "resource", "tags", "timestamp"]
  },

  // restrict allowed resource hosts (no network requests are ever made)
  resourcePolicy: {
    allowHosts: ["docs.example.com", "github.com", "cloud.google.com"]
  },

  mcp: {
    readonly: true,
    exposeDiagnostics: true,
    exposeGraph: true
  }
});
```

### Presets

- `@okfxjs/preset-recommended` — balanced defaults (spec errors, common hygiene warnings, broken-link warnings, light agent advice).
- `@okfxjs/preset-strict` — CI-oriented; promotes many warnings to errors and sets `failOn: "warning"`.
- `@okfxjs/preset-agent-ready` — agent-oriented; checks summaries, backlinks, metric source links, owners, and usage sections.

Presets may be referenced by short name (`recommended`) or full package name
(`@okfxjs/preset-recommended`).

---

## Diagnostics model

`okfx` cleanly separates three questions:

| Mode | Question | Failure means |
| --- | --- | --- |
| `validate` | Is this valid OKF? | The bundle violates the base spec. |
| `lint` | Is this maintainable OKF? | The bundle has quality/style/security issues. |
| `doctor` | Is this useful for agents and production? | The bundle works but is weak context. |

Every diagnostic has a stable `code` (`<category>/<rule-name>`), a `severity`, a message,
and an optional path/location and fix. Categories: `spec`, `hygiene`, `graph`, `style`,
`agent`, `security`, `plugin`. The full built-in rule set is documented in
[`docs/rules/catalog.md`](./docs/rules/catalog.md).

Severities: `error` (must fix), `warning` (should review), `advice` (optional
improvement), `info` (informational).

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success; no diagnostics crossed the failure threshold. |
| `1` | Diagnostics, diff changes, or format-check differences crossed the threshold. |
| `2` | Invalid config, arguments, or runtime failure. |
| `3` | Plugin load or execution failure. |

---

## MCP server

`@okfxjs/mcp` exposes an OKF bundle to AI agents over the Model Context Protocol. The
server is **read-only, local-only, and makes no network or LLM calls** by default. Full
details: [`docs/mcp/server.md`](./docs/mcp/server.md).

```bash
# start a stdio MCP server for a bundle
okf mcp ./knowledge

# inspect the configuration without starting the transport
okf mcp ./knowledge --describe
```

**Resources:** `okf://bundle/current`, `okf://graph/current`,
`okf://diagnostics/current`, `okf://concept/{id}`.

**Tools:** `okf_list_bundles`, `okf_search_concepts`, `okf_get_concept`,
`okf_get_neighbors`, `okf_get_backlinks`, `okf_get_graph`, `okf_validate_bundle`,
`okf_lint_bundle`, `okf_explain_diff`, `okf_get_diagnostics`.

**Prompts:** `review_okf_changes`, `draft_okf_concept`, `improve_agent_readiness`,
`explain_metric_context`, `trace_table_to_metric`.

Example MCP client entry:

```json
{
  "mcpServers": {
    "okf": {
      "command": "okf",
      "args": ["mcp", "./knowledge"]
    }
  }
}
```

---

## GitHub Action

`@okfxjs/github-action` provides a CI quality gate that validates, lints, graphs, and
doctors a bundle, then writes a job summary and (optionally) a PR comment.

```yaml
name: OKF
on:
  pull_request:
  push:
    branches: [main]

jobs:
  okf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: okfx/okfx/packages/github-action@v0
        with:
          cli-version: "0.1.2"
          bundle: ./knowledge
          lint-format: json
          graph-out: okf-graph.json
          summary: "true"
          pr-comment: "true"
```

`okf lint --format sarif` output can also be uploaded to GitHub code scanning.

---

## Adapters (import / export)

Adapters produce **reviewable file changes** — they never silently mutate a bundle. The
recommended workflow is import → format → lint → review → commit. See
[`docs/adapters/producers.md`](./docs/adapters/producers.md).

Producer adapters (`okf import <adapter> --input <file.json>`):

- `@okfxjs/adapter-markdown`
- `@okfxjs/adapter-openapi`
- `@okfxjs/adapter-dbt`
- `@okfxjs/adapter-datahub`
- `@okfxjs/adapter-bigquery`

Consumer adapters (`okf export <target>`):

- `@okfxjs/adapter-static-site` — export a self-contained static site.

```bash
okf import dbt --input ./target/manifest.json --out ./knowledge --dry-run
okf import dbt --input ./target/manifest.json --out ./knowledge --write
okf fmt ./knowledge && okf lint ./knowledge
```

---

## Editor integration

`@okfxjs/vscode` is a VS Code extension that surfaces inline diagnostics, format-on-save,
frontmatter and concept-link completion, go-to-concept, a graph preview, a doctor panel,
a backlinks panel, and quick fixes for common missing-frontmatter diagnostics.

---

## Architecture

`okfx` is a hybrid **Rust core + TypeScript ecosystem** designed around a stable JSON
intermediate representation (IR). See [`docs/architecture/overview.md`](./docs/architecture/overview.md).

```text
┌───────────────────────────────────────────────────────────┐
│                     User interfaces                        │
│   CLI (okf)   VS Code   GitHub Action   MCP server         │
└───────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────────────────────────────────────┐
│                   TypeScript ecosystem                     │
│  @okfxjs/core  okfx  @okfxjs/mcp  @okfxjs/plugin-api        │
│  @okfxjs/adapter-*  @okfxjs/preset-*  @okfxjs/github-action      │
└───────────────────────────────────────────────────────────┘
                            │  JSON IR over N-API / WASM
┌───────────────────────────────────────────────────────────┐
│                        Rust core                           │
│  okfx_parser  okfx_resolver  okfx_rules  okfx_fmt          │
│  okfx_graph  okfx_index  okfx_pack  okfx_fs  okfx_cache    │
└───────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────────────────────────────────────┐
│         Knowledge bundle (Markdown + YAML + links)         │
└───────────────────────────────────────────────────────────┘
```

- **`@okfxjs/core`** owns the deterministic TypeScript engines and the JSON IR
  (`BundleIR`, `ConceptIR`, `LinkIR`, `DiagnosticIR`, `GraphIR`, …). It is the default
  runtime today.
- The **Rust crates** provide opt-in accelerated parsing and formatting through N-API
  or WASM, plus a standalone `okfx` binary. The regular Core/CLI paths remain on the
  deterministic TypeScript implementation; async `*Accelerated` helpers probe native,
  then WASM, then TypeScript. No Rust toolchain is required to use `okfx`.
- Plugins and adapters exchange only the stable JSON IR — never internal Rust structs.

---

## Repository layout

This is a pnpm + Cargo monorepo.

```text
okfx/
  crates/        Rust core crates and native/WASM/CLI bindings
  packages/      TypeScript packages published under @okfxjs/*
  examples/      Runnable example bundles
  fixtures/      Golden-file and case fixtures for tests
  fuzz/          cargo-fuzz targets for the parser and resolver
  npm/           npm distribution shells for native/WASM binaries
  docs/          Documentation (itself an OKF-style bundle)
```

### TypeScript packages (`packages/*`)

| Package | Responsibility |
| --- | --- |
| `@okfxjs/core` | Data model, JSON IR, and deterministic engines (parse, validate, lint, fmt, graph, diff, pack, index, doctor). |
| `okfx` | `okf` command-line interface. |
| `@okfxjs/mcp` | Read-only MCP server for OKF bundles. |
| `@okfxjs/plugin-api` | Public plugin authoring API (`definePlugin`). |
| `@okfxjs/preset-recommended` · `-strict` · `-agent-ready` | Rule presets. |
| `@okfxjs/adapter-markdown` · `-openapi` · `-dbt` · `-datahub` · `-bigquery` | Producer adapters. |
| `@okfxjs/adapter-static-site` | Static-site consumer adapter. |
| `@okfxjs/github-action` | CI quality-gate action wrapper. |
| `@okfxjs/vscode` | VS Code extension. |

### Rust crates (`crates/*`)

| Crate | Responsibility |
| --- | --- |
| `okfx_core` | Shared core types and diagnostics. |
| `okfx_fs` | File discovery, ignore rules, path normalization. |
| `okfx_parser` | Markdown + YAML frontmatter parsing, headings, links, content hashing. |
| `okfx_resolver` | Concept ID and Markdown link resolution, backlinks. |
| `okfx_rules` | Built-in validation and lint rules. |
| `okfx_fmt` | Formatter and safe file edits. |
| `okfx_graph` | Graph construction and analysis. |
| `okfx_diff` | Semantic diff between bundles. |
| `okfx_pack` | Manifest, checksums, and pack metadata. |
| `okfx_index` | Local search index. |
| `okfx_cache` | Incremental cache keys and hashing. |
| `okfx_napi` | Native Node.js binding (JSON IR boundary). |
| `okfx_wasm` | WASM fallback binding. |
| `okfx_cli` | Standalone Rust `okfx` binary. |

---

## Development

```bash
# install workspace dependencies
pnpm install

# build all TypeScript packages (also makes the CLI executable)
pnpm build

# type-check the workspace
pnpm typecheck

# run the TypeScript test suite (vitest)
pnpm test

# validate, lint, and format-check this repository's OKF content
pnpm check:okf
```

Rust workspace:

```bash
# enforce rustfmt and Clippy
pnpm check:rust

# test all crates
cargo test --workspace

# build the WASM fallback
cargo build -p okfx_wasm --target wasm32-unknown-unknown

# build the standalone binary
cargo build -p okfx_cli --release
```

CI (`.github/workflows/ci.yml`) runs the TypeScript build, typecheck, tests, dependency
audit, repository OKF checks, rustfmt, Clippy, the full Rust test suite, and
WASM/standalone builds on every push and PR. Release verification applies the same gates.

See [`docs/testing/strategy.md`](./docs/testing/strategy.md) for the full verification
strategy and [`CONTRIBUTING.md`](./CONTRIBUTING.md) to get started.

---

## Project status

This repository currently includes the planned TypeScript, Rust, agent, adapter,
packaging, and index surfaces. Future releases should focus on compatibility hardening,
performance, and public API stability rather than filling missing command surfaces.

| Area | Status |
| --- | --- |
| TypeScript toolkit | `validate`, `lint`, `fmt`, `graph`, `doctor`, `diff`, `pack`, `index`, config, presets, plugins. |
| Rust core | Parser, resolver, rules, formatter, graph, diff, pack, index, cache, N-API, WASM, standalone CLI. |
| Agent and automation | Read-only MCP server, GitHub Action, VS Code extension, SARIF and PR-summary surfaces. |
| Adapters | Markdown, OpenAPI, dbt, DataHub, BigQuery importers, plus static-site export. |

Versioning is semver; `0.x` APIs are unstable and may change between minor releases.

---

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the
development workflow, monorepo conventions, and how to add rules, adapters, and plugins.
This project uses [Conventional Commits](https://www.conventionalcommits.org/) (e.g.
`feat(graph): …`, `fix(cli): …`, `docs: …`).

## License

[MIT](./LICENSE) © okfx
