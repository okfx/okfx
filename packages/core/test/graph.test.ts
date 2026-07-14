import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  backlinksForConcept,
  buildGraph,
  graphToCytoscape,
  graphToDot,
  graphToHtml,
  loadBundle,
  type OkfxGraphIR
} from "../src/index.js";

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
      expect(backlinksForConcept(graph, "constructor")).toEqual([]);
      expect(graph.analysis.cycles).toEqual([["a", "b", "a"]]);
      expect(graph.analysis.orphanConceptIds).toEqual(["orphan"]);
      expect(graph.analysis.topReferencedConcepts[0]).toEqual({ id: "a", count: 1 });
    });
  });

  it("analyzes a dense acyclic graph without enumerating every path", async () => {
    const nodeCount = 40;
    const files = Object.fromEntries(Array.from({ length: nodeCount }, (_, source) => {
      const links = Array.from({ length: nodeCount - source - 1 }, (_, offset) => {
        const target = source + offset + 1;
        return `[Node ${target}](node-${target}.md)`;
      });
      return [
        `node-${source}.md`,
        `---\ntype: Note\ntitle: Node ${source}\n---\n${links.join("\n")}\n`
      ];
    }));

    await withBundle(files, async (root) => {
      const bundle = await loadBundle(root, { loadConfigFile: false });
      const startedAt = performance.now();
      const graph = buildGraph(bundle);
      const elapsedMs = performance.now() - startedAt;

      expect(graph.stats.edgeCount).toBe(780);
      expect(graph.analysis.cycles).toEqual([]);
      expect(elapsedMs).toBeLessThan(1_000);
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

  it("does not treat metadata target collisions as concept links", async () => {
    await withBundle({
      "source.md": "---\ntype: Note\ntitle: Source\ntags:\n  - analytics\n---\n# Source\n",
      "target.md": "---\ntype: Note\ntitle: Target\n---\n# Target\n"
    }, async (root) => {
      const bundle = await loadBundle(root, { loadConfigFile: false });
      bundle.concepts.find((concept) => concept.path === "target.md")!.id = "tag:analytics";

      const graph = buildGraph(bundle);

      expect(graph.edges).toContainEqual(expect.objectContaining({
        kind: "tag",
        source: "source",
        target: "tag:analytics"
      }));
      expect(graph.analysis.backlinks["tag:analytics"]).toEqual([]);
      expect(graph.analysis.orphanConceptIds).toEqual(["source", "tag:analytics"]);
      expect(graph.analysis.isolatedClusterCount).toBe(2);
    });
  });

  it("connects concepts to reserved graph nodes without reporting broken links", async () => {
    await withBundle({
      "index.md": "# Index\n",
      "log.md": "# Log\n",
      "a.md": "---\ntype: Note\ntitle: A\n---\n[Index](index.md)\n[Log](log.md)\n"
    }, async (root) => {
      const graph = buildGraph(await loadBundle(root, { loadConfigFile: false }));

      expect(graph.nodes.map((node) => node.id).sort()).toEqual(["a", "index", "log"]);
      expect(graph.edges.map((edge) => [edge.target, edge.resolved])).toEqual([
        ["index", true],
        ["log", true]
      ]);
      expect(graph.stats.brokenLinkCount).toBe(0);
    });
  });

  it("reports advanced graph analysis", async () => {
    await withBundle({
      "hub.md": "---\ntype: Note\ntitle: Hub\n---\n[A](a.md)\n[B](b.md)\n",
      "a.md": "---\ntype: Note\ntitle: A\n---\n# A\n",
      "b.md": "---\ntype: Note\ntitle: B\n---\n# B\n",
      "old-a.md": "---\ntype: Note\ntitle: Old A\ntimestamp: 2025-01-01T00:00:00.000Z\n---\n[Old B](old-b.md)\n",
      "old-b.md": "---\ntype: Note\ntitle: Old B\ntimestamp: 2025-01-02T00:00:00.000Z\n---\n# Old B\n",
      "ambiguous.md": "---\ntype: Note\ntitle: Ambiguous\ntimestamp: 2000-01-01T00:00:00\n---\n# Ambiguous\n"
    }, async (root) => {
      const graph = buildGraph(await loadBundle(root, { loadConfigFile: false }), {
        highDegreeThreshold: 2,
        now: new Date("2026-07-07T00:00:00.000Z")
      });

      expect(graph.analysis.highDegreeHubs).toEqual([{
        id: "hub",
        incoming: 0,
        outgoing: 2,
        degree: 2
      }]);
      expect(graph.analysis.missingIndexSuggestions).toEqual([{
        path: "index.md",
        reason: "Directory has concepts but no index.md entrypoint."
      }]);
      expect(graph.analysis.staleSubgraphs).toEqual([{
        conceptIds: ["old-a", "old-b"],
        latestTimestamp: "2025-01-02T00:00:00.000Z",
        staleConceptCount: 2
      }]);
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
      const html = graphToHtml(graph);
      expect(html).toContain("<title>OKF Graph</title>");
      expect(html).toContain('<pre><code id="graph-json">{');
      expect(html).toContain('"nodes"');
      expect(html).not.toContain("<script");
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

  it("escapes control characters in DOT identifiers", () => {
    const id = "line\n\"\\identifier";
    const graph = {
      nodes: [{ id, path: "concept.md", type: "Note" }],
      edges: [],
      stats: {
        nodeCount: 1,
        edgeCount: 0,
        orphanCount: 1,
        brokenLinkCount: 0,
        cycleCount: 0
      },
      analysis: {
        backlinks: {},
        brokenLinks: [],
        orphanConceptIds: [id],
        isolatedClusterCount: 1,
        cycles: [],
        highDegreeHubs: [],
        missingIndexSuggestions: [],
        staleSubgraphs: [],
        topReferencedConcepts: []
      }
    } satisfies OkfxGraphIR;

    expect(graphToDot(graph)).toContain(`  ${JSON.stringify(id)} [label=`);
  });
});
