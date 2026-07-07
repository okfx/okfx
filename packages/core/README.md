# @okfx/core

Core TypeScript APIs and deterministic engines for [okfx](https://github.com/okfx/okfx),
the developer toolkit for Open Knowledge Format (OKF) bundles.

This package owns the stable JSON intermediate representation (IR) and the engines shared
by the `okf` CLI, the MCP server, plugins, and adapters. It runs a pure TypeScript
implementation and transparently uses the optional native (Rust/N-API) binding when
available, falling back to TypeScript otherwise.

## Install

```bash
pnpm add @okfx/core
```

## Usage

```ts
import {
  loadBundle,
  validateBundle,
  lintBundle,
  buildGraph,
  doctorBundle,
  defineConfig
} from "@okfx/core";

const bundle = await loadBundle("./knowledge");

const validation = validateBundle(bundle);   // spec conformance
const lint = lintBundle(bundle);              // quality/graph/style/security rules
const graph = buildGraph(bundle);             // nodes, edges, backlinks, cycles
const doctor = doctorBundle(bundle);          // agent-readiness score + diagnostics

console.log(validation.ok, lint.counts, graph.stats, doctor.score);
```

Define configuration with full type-checking:

```ts
export default defineConfig({
  presets: ["recommended", "agent-ready"],
  rules: { "graph/broken-internal-link": "error" },
  failOn: "error"
});
```

## Key exports

- **Loading & IR:** `loadBundle`, `parseMarkdownDocument`, and the `BundleIR`,
  `ConceptIR`, `LinkIR`, `DiagnosticIR`, `GraphIR` types.
- **Engines:** `validateBundle`, `lintBundle` / `lintBundleWithPlugins`, `formatBundle` /
  `formatMarkdownFile`, `buildGraph` (+ `graphToDot`, `graphToHtml`, `graphToCytoscape`),
  `diffBundles`, `packBundle`, `buildSearchIndex`, `doctorBundle`.
- **Config & plugins:** `defineConfig`, `loadConfig`, `resolveConfig`,
  `loadConfiguredPlugins`, built-in presets.
- **Native backend:** `getNativeBackendStatus` and `*Accelerated` helpers.

## Documentation

- [Architecture overview](https://github.com/okfx/okfx/blob/main/docs/architecture/overview.md)
- [Rule catalog](https://github.com/okfx/okfx/blob/main/docs/rules/catalog.md)
- [Project README](https://github.com/okfx/okfx#readme)

## License

[MIT](https://github.com/okfx/okfx/blob/main/LICENSE)
