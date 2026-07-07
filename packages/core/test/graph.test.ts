import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { buildGraph, graphToDot, graphToHtml, loadBundle } from "../src/index.js";

async function withBundle(files: Record<string, string>, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "okfx-graph-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(root, path);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("buildGraph", () => {
  it("builds graph stats and analysis", async () => {
    await withBundle({
      "a.md": "---\ntype: Note\ntitle: A\n---\n[B](b.md)\n[Missing](missing.md)\n",
      "b.md": "---\ntype: Note\ntitle: B\n---\n[A](a.md)\n",
      "orphan.md": "---\ntype: Note\ntitle: Orphan\n---\n# Orphan\n"
    }, async (root) => {
      const graph = buildGraph(await loadBundle(root, { loadConfigFile: false }));

      expect(graph.stats).toMatchObject({
        nodeCount: 3,
        edgeCount: 3,
        brokenLinkCount: 1,
        orphanCount: 1,
        cycleCount: 1
      });
      expect(graph.analysis.backlinks.a).toEqual(["b"]);
      expect(graph.analysis.orphanConceptIds).toEqual(["orphan"]);
      expect(graph.analysis.topReferencedConcepts[0]).toEqual({ id: "a", count: 1 });
    });
  });
});

describe("graph formatters", () => {
  it("formats DOT and HTML", async () => {
    await withBundle({
      "a.md": "---\ntype: Note\ntitle: A\n---\n[B](b.md)\n",
      "b.md": "---\ntype: Note\ntitle: B\n---\n# B\n"
    }, async (root) => {
      const graph = buildGraph(await loadBundle(root, { loadConfigFile: false }));

      expect(graphToDot(graph)).toContain('"a" -> "b"');
      expect(graphToHtml(graph)).toContain("<title>OKF Graph</title>");
    });
  });
});
