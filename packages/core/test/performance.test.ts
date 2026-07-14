import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { buildGraph, buildSearchIndex, diffBundles, lintBundle, loadBundle, parseMarkdownDocument } from "../src/index.js";
import { metricMissingSourceDiagnostics } from "../src/agent-rules.js";
import type { BundleIR, ConceptIR } from "../src/types.js";

const roots: string[] = [];

describe("performance baselines", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("loads, lints, graphs, and indexes a large linked bundle", async () => {
    const root = await makeLargeBundle(220);
    const started = performance.now();

    const bundle = await loadBundle(root, { loadConfigFile: false });
    const lint = lintBundle(bundle);
    const graph = buildGraph(bundle);
    const index = buildSearchIndex(bundle);
    const elapsedMs = performance.now() - started;

    expect(bundle.stats.conceptCount).toBe(220);
    expect(bundle.stats.linkCount).toBeGreaterThan(400);
    expect(lint.counts.error).toBe(0);
    expect(graph.stats.nodeCount).toBeGreaterThan(200);
    expect(index.documents).toHaveLength(220);
    expect(elapsedMs).toBeLessThan(8000);
  }, 12000);

  it("handles many diagnostics without pathological slowdown", async () => {
    const root = await makeDiagnosticBundle(160);
    const started = performance.now();

    const lint = lintBundle(await loadBundle(root, { loadConfigFile: false }));
    const elapsedMs = performance.now() - started;

    expect(lint.diagnostics.length).toBeGreaterThan(300);
    expect(lint.counts.error).toBeGreaterThan(100);
    expect(elapsedMs).toBeLessThan(8000);
  }, 12000);

  it("indexes source locations once for link-heavy documents", () => {
    const count = 5_000;
    const content = Array.from(
      { length: count },
      (_, index) => `# Heading ${index}\n[Target](target.md)`
    ).join("\n");
    const started = performance.now();

    const parsed = parseMarkdownDocument("large.md", content, "large");
    const elapsedMs = performance.now() - started;

    expect(parsed.body.headings).toHaveLength(count);
    expect(parsed.links).toHaveLength(count);
    expect(parsed.links.at(-1)?.location.start.line).toBe(count * 2);
    expect(elapsedMs).toBeLessThan(1500);
  }, 5000);

  it("does not rescan the tail for every unmatched link label", () => {
    const content = "[".repeat(25_000);
    const started = performance.now();

    const parsed = parseMarkdownDocument("malformed.md", content, "malformed");
    const elapsedMs = performance.now() - started;

    expect(parsed.links).toEqual([]);
    expect(elapsedMs).toBeLessThan(1000);
  }, 5000);

  it("bounds overlapping malformed link destinations", () => {
    const content = `[${"[x](".repeat(8_000)}]`;
    const started = performance.now();

    const parsed = parseMarkdownDocument("malformed.md", content, "malformed");
    const elapsedMs = performance.now() - started;

    expect(parsed.links).toEqual([]);
    expect(elapsedMs).toBeLessThan(1000);
  }, 5000);

  it("indexes unmatched backtick runs by delimiter length", () => {
    const content = Array.from(
      { length: 1_600 },
      (_, index) => `${"`".repeat(index + 1)}x`
    ).join("");
    const started = performance.now();

    const parsed = parseMarkdownDocument("backticks.md", content, "backticks");
    const elapsedMs = performance.now() - started;

    expect(parsed.links).toEqual([]);
    expect(elapsedMs).toBeLessThan(1000);
  }, 5000);

  it("indexes metric source types once for large bundles", () => {
    const count = 8_000;
    const concepts: ConceptIR[] = Array.from({ length: count }, (_, index) => ({
      id: `metric-${index}`,
      path: `metric-${index}.md`,
      type: "Metric",
      frontmatter: {},
      body: { raw: "", text: "", headings: [] },
      links: [],
      contentHash: ""
    }));
    const bundle = bundleWithConcepts(concepts);
    const started = performance.now();

    const diagnostics = metricMissingSourceDiagnostics(bundle);
    const elapsedMs = performance.now() - started;

    expect(diagnostics).toHaveLength(count);
    expect(elapsedMs).toBeLessThan(1000);
  }, 5000);

  it("groups many duplicate concept values without repeated array copies", () => {
    const count = 40_000;
    const concepts: ConceptIR[] = Array.from({ length: count }, (_, index) => ({
      id: `concept-${index}`,
      path: `concept-${index}.md`,
      type: "Note",
      title: "Shared title",
      description: "Description",
      frontmatter: { type: "Note", title: "Shared title", description: "Description" },
      frontmatterRaw: "type: Note\ntitle: Shared title\ndescription: Description",
      body: { raw: "# Body", text: "# Body", headings: [] },
      links: [],
      contentHash: ""
    }));
    const bundle = bundleWithConcepts(concepts);
    const started = performance.now();

    const result = lintBundle(bundle, {
      config: {
        rules: {
          "graph/orphan-concept": "off",
          "graph/no-backlinks": "off"
        }
      }
    });
    const elapsedMs = performance.now() - started;

    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "hygiene/duplicate-title"))
      .toHaveLength(count);
    expect(elapsedMs).toBeLessThan(1000);
  }, 5000);

  it("pairs large same-hash rename groups without shifting arrays", () => {
    const count = 40_000;
    const concepts = (prefix: string): ConceptIR[] => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      path: `${prefix}-${index}.md`,
      type: "Note",
      title: `Title ${index}`,
      description: "Description",
      frontmatter: { type: "Note", title: `Title ${index}`, description: "Description" },
      frontmatterRaw: `type: Note\ntitle: Title ${index}\ndescription: Description`,
      body: { raw: "# Body", text: "# Body", headings: [] },
      links: [],
      contentHash: "shared"
    }));
    const before = bundleWithConcepts(concepts("before"));
    const after = bundleWithConcepts(concepts("after"));
    const started = performance.now();

    const diff = diffBundles(before, after, {
      doctor: {
        config: {
          rules: {
            "graph/orphan-concept": "off"
          }
        }
      }
    });
    const elapsedMs = performance.now() - started;

    expect(diff.renamedConcepts).toHaveLength(count);
    expect(elapsedMs).toBeLessThan(1500);
  }, 5000);
});

async function makeLargeBundle(count: number): Promise<string> {
  const root = await tempRoot("large");
  await mkdir(join(root, "concepts"), { recursive: true });
  await writeFile(join(root, "index.md"), "# Index\n\n[Start](concepts/c000.md)\n", "utf8");

  for (let index = 0; index < count; index += 1) {
    const id = `c${index.toString().padStart(3, "0")}`;
    const next = `c${((index + 1) % count).toString().padStart(3, "0")}`;
    const previous = `c${((index + count - 1) % count).toString().padStart(3, "0")}`;
    await writeFile(
      join(root, "concepts", `${id}.md`),
      `---
type: Note
title: Concept ${id}
description: Generated concept ${id}
tags:
  - performance
---
# Concept ${id}

See [next](${next}.md), [previous](${previous}.md), and [index](../index.md).
`,
      "utf8"
    );
  }

  return root;
}

async function makeDiagnosticBundle(count: number): Promise<string> {
  const root = await tempRoot("diagnostics");
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(root, `bad-${index}.md`), "---\ntitle: \n---\n", "utf8");
  }
  return root;
}

async function tempRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `okfx-${name}-`));
  roots.push(root);
  return root;
}

function bundleWithConcepts(concepts: ConceptIR[]): BundleIR {
  return {
    root: "/bundle",
    okfVersion: "0.1",
    concepts,
    indexes: [],
    logs: [],
    links: [],
    diagnostics: [],
    stats: {
      fileCount: concepts.length,
      conceptCount: concepts.length,
      indexCount: 0,
      logCount: 0,
      linkCount: 0,
      brokenLinkCount: 0,
      diagnosticCount: 0
    }
  };
}
