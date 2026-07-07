import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { buildGraph, graphToCytoscape, graphToDot, graphToHtml, loadBundle } from "../src/index.js";

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

  it("includes resource and tag metadata edges", async () => {
    await withBundle({
      "a.md": "---\ntype: Note\ntitle: A\nresource:\n  - https://docs.example.com/a\n  - bigquery://project/dataset/table\n  - https://docs.example.com/a\ntags:\n  - analytics\n  - trusted\n  - analytics\n---\n# A\n"
    }, async (root) => {
      const graph = buildGraph(await loadBundle(root, { loadConfigFile: false }));

      expect(graph.stats).toMatchObject({
        nodeCount: 1,
        edgeCount: 4,
        orphanCount: 1
      });
      expect(graph.edges.map((edge) => [edge.kind, edge.target, edge.label])).toEqual([
        ["resource", "resource:https://docs.example.com/a", "https://docs.example.com/a"],
        ["resource", "resource:bigquery://project/dataset/table", "bigquery://project/dataset/table"],
        ["tag", "tag:analytics", "analytics"],
        ["tag", "tag:trusted", "trusted"]
      ]);
      expect(graph.analysis.backlinks.a).toEqual([]);
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
      expect(graphToCytoscape(graph).elements).toMatchObject({
        nodes: expect.arrayContaining([
          { data: expect.objectContaining({ id: "a", label: "A", type: "Note" }) },
          { data: expect.objectContaining({ id: "b", label: "B", type: "Note" }) }
        ]),
        edges: [
          { data: expect.objectContaining({ source: "a", target: "b", kind: "markdown-link" }) }
        ]
      });
    });
  });
});
