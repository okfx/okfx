# @okfx/core

Core TypeScript APIs and deterministic engines for [okfx](https://github.com/okfx/okfx),
the developer toolkit for Open Knowledge Format (OKF) bundles.

This package owns the stable JSON intermediate representation (IR) and the engines shared
by the `okf` CLI, the MCP server, plugins, and adapters. Its production APIs use the
deterministic TypeScript implementation. Optional, explicit accelerated helpers can
probe a Rust/N-API binding, then WASM, and fall back to TypeScript.

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
- **Optional backends:** `getNativeBackendStatusAsync`,
  `parseMarkdownDocumentAcceleratedAsync`, and
  `formatMarkdownFileAcceleratedAsync`. The synchronous helpers probe N-API only;
  the async helpers can initialize ESM WASM packages.

## Documentation

- [Architecture overview](https://github.com/okfx/okfx/blob/main/docs/architecture/overview.md)
- [Rule catalog](https://github.com/okfx/okfx/blob/main/docs/rules/catalog.md)
- [Project README](https://github.com/okfx/okfx#readme)

## License

[MIT](https://github.com/okfx/okfx/blob/main/LICENSE)
