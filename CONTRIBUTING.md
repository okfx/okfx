# Contributing to okfx

Thanks for your interest in improving `okfx` — the developer toolkit for Open Knowledge
Format bundles. This guide covers local setup, the monorepo layout, how to verify your
work, and how to extend the toolkit with rules, adapters, and plugins.

By participating you agree to keep the project's core invariants intact: `okfx` is
**local-first** (no network, telemetry, or LLM calls by default) and **deterministic**
(stable sorting, hashes, IDs, and diagnostics).

---

## Prerequisites

- [Node.js](https://nodejs.org) `>= 20`
- [pnpm](https://pnpm.io) `11.8.0` (the repo pins `packageManager`; `corepack enable` will activate it)
- [Rust](https://rustup.rs) stable — only needed to work on the `crates/*` native core
  - `rustup target add wasm32-unknown-unknown` for the WASM fallback
  - `cargo install cargo-fuzz` for fuzzing (optional)

You do **not** need Rust to work on the TypeScript packages: `@okfx/core` runs a pure
TypeScript implementation and only uses the native binding when it is available.

---

## Getting started

```bash
git clone git@github.com:okfx/okfx.git
cd okfx
pnpm install

# build every TypeScript package (and make the CLI executable)
pnpm build

# run the CLI from source against an example bundle
pnpm okf doctor ./examples/data-platform-bundle
```

---

## Monorepo layout

```text
crates/        Rust core crates + native (N-API) / WASM / standalone CLI bindings
packages/      TypeScript packages published under @okfx/*
examples/      Runnable example bundles (minimal, data-platform, api, metric)
fixtures/      Case + golden-file fixtures used by tests
fuzz/          cargo-fuzz targets for the parser and resolver
npm/           npm distribution shells for prebuilt native/WASM binaries
docs/          Documentation, authored as an OKF-style bundle
```

The engines live in `packages/core/src` (`parser`, `validation`, `lint`, `format`,
`graph`, `diff`, `pack`, `search-index`, `doctor`, `plugins`, `config`). The `okf` CLI
in `packages/cli/src/commands` is a thin layer over `@okfx/core`.

---

## Verifying your work

Run the full local gate before opening a pull request. These mirror
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) and
[`docs/testing/strategy.md`](./docs/testing/strategy.md):

```bash
pnpm build
pnpm typecheck
pnpm test                     # vitest
pnpm audit --audit-level moderate

# if you touched crates/*
cargo test --workspace
cargo build -p okfx_wasm --target wasm32-unknown-unknown
cargo build -p okfx_cli --release
```

- Tests live in `packages/*/test/` (vitest) and inline Rust `#[cfg(test)]` modules.
- `packages/core/test/performance.test.ts` guards performance with synthetic bundles.
- Prefer adding fixtures under `fixtures/` and asserting against stable output.

---

## Coding conventions

- **TypeScript**: `strict` mode, ES modules, `NodeNext` resolution. Import local modules
  with the `.js` extension (e.g. `import { loadBundle } from "./bundle.js"`).
- **Determinism**: sort collections, keep diagnostics ordered, and avoid wall-clock or
  environment-dependent output. Injectable clocks (`now`) are preferred over `new Date()`
  inside engines.
- **No network / LLM / telemetry** in default code paths. Anything that needs the network
  must be explicit and opt-in.
- **Comments** explain intent or constraints, not the obvious. Do not narrate code.
- Keep the **JSON IR** (`BundleIR`, `ConceptIR`, `GraphIR`, `DiagnosticIR`, …) stable —
  it is the contract shared by the CLI, MCP server, plugins, and adapters.

---

## Extending okfx

### Add a built-in lint rule

1. Add the rule to `builtInLintRules` in `packages/core/src/lint.ts` with a stable
   `id` of the form `<category>/<rule-name>` and a `defaultSeverity`.
2. Enable it at an appropriate severity in the relevant preset
   (`packages/preset-*/src/index.ts`) and in `builtinPresets` in
   `packages/core/src/config.ts`.
3. Document it in [`docs/rules/catalog.md`](./docs/rules/catalog.md).
4. Add tests in `packages/core/test/lint.test.ts`.

Categories in use: `spec`, `hygiene`, `graph`, `style`, `agent`, `security`.

### Add a doctor check

Add it to `conceptDoctorDiagnostics` (or `doctorDiagnostics`) in
`packages/core/src/doctor.ts`, keep it advice/warning level unless it is a true failure,
and cover it in `packages/core/test/doctor.test.ts`.

### Write a plugin (external package)

Plugins are executable code that receive only the JSON IR. Use `@okfx/plugin-api`:

```ts
import { definePlugin } from "@okfx/plugin-api";

export default definePlugin({
  name: "@acme/okfx-plugin-governance",
  version: "0.1.0",
  rules: {
    "acme/owner-required": {
      meta: { description: "Concepts must declare an owner.", defaultSeverity: "warning" },
      run({ bundle }) {
        return bundle.concepts
          .filter((concept) => typeof concept.frontmatter.owner !== "string")
          .map((concept) => ({
            code: "acme/owner-required",
            severity: "warning",
            message: "Concept should declare an owner.",
            path: concept.path,
            conceptId: concept.id
          }));
      }
    }
  }
});
```

Enable it explicitly in a bundle's `okfx.config.*` under `plugins`. Users can disable
configured plugins with `okf lint --no-plugins`. See
[`docs/plugins/api.md`](./docs/plugins/api.md).

### Add an adapter

Producer adapters generate **reviewable** files and must never silently mutate a bundle.
Add a `packages/adapter-<name>` package exporting a `produce*` function, wire it into
`packages/cli/src/commands/import.ts` (producers) or `export.ts` (consumers), and add
tests under `packages/adapter-<name>/test/`. See
[`docs/adapters/producers.md`](./docs/adapters/producers.md).

### Work on the Rust core

The `crates/*` provide the native-acceleration path behind the JSON IR. Keep the N-API
surface in `crates/okfx_napi/src/lib.rs` in sync with the TypeScript fallbacks in
`packages/core/src/native.ts`, and promote fuzz-discovered edge cases into
`crates/okfx_parser/tests/fuzz_regression.rs`. Fuzzing:

```bash
cargo fuzz run parser
cargo fuzz run resolver
```

---

## Commits and pull requests

- This project uses [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`, `test: …`, `refactor: …`.
- Keep pull requests focused, and update docs and tests alongside behavior changes.
- Ensure the full verification gate above passes and CI is green.
- Describe the "why" of the change, not just the "what".

---

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
