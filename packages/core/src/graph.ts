import { conceptIdFromPath } from "./paths.js";
import type { BundleIR, ConceptIR, GraphEdgeIR, GraphIR, GraphNodeIR, IndexFileIR, LinkIR, LogFileIR } from "./types.js";

export interface GraphAnalysisIR {
  backlinks: Record<string, string[]>;
  brokenLinks: Array<{
    source: string;
    targetRaw: string;
    path?: string;
  }>;
  orphanConceptIds: string[];
  isolatedClusterCount: number;
  cycles: string[][];
  topReferencedConcepts: Array<{
    id: string;
    count: number;
  }>;
}

export interface OkfxGraphIR extends GraphIR {
  analysis: GraphAnalysisIR;
}

export function buildGraph(bundle: BundleIR): OkfxGraphIR {
  const nodes = [
    ...bundle.concepts.map(graphNode),
    ...bundle.indexes.map((file) => reservedNode(file, "Index")),
    ...bundle.logs.map((file) => reservedNode(file, "Log"))
  ];
  const edges = bundle.links
    .filter((link) => link.kind === "internal")
    .map(graphEdge);
  const analysis = analyzeGraph(bundle, edges);

  return {
    nodes,
    edges,
    analysis,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      orphanCount: analysis.orphanConceptIds.length,
      brokenLinkCount: analysis.brokenLinks.length,
      cycleCount: analysis.cycles.length
    }
  };
}

export function graphToDot(graph: OkfxGraphIR): string {
  const lines = [
    "digraph okf {",
    "  graph [rankdir=LR];",
    "  node [shape=box];"
  ];

  for (const node of graph.nodes) {
    lines.push(`  ${dotId(node.id)} [label=${JSON.stringify(node.title ?? node.id)}];`);
  }

  for (const edge of graph.edges) {
    if (!edge.resolved) {
      continue;
    }
    lines.push(`  ${dotId(edge.source)} -> ${dotId(edge.target)} [label=${JSON.stringify(edge.label ?? edge.kind)}];`);
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function graphToHtml(graph: OkfxGraphIR): string {
  const graphJson = JSON.stringify(graph, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OKF Graph</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #1f2933; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .stats { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1rem 0; }
    .stat { border: 1px solid #d6dde5; border-radius: 6px; padding: 0.5rem 0.75rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; }
    pre { overflow: auto; background: #f6f8fa; border: 1px solid #d6dde5; border-radius: 6px; padding: 1rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>OKF Graph</h1>
  <div class="stats">
    <div class="stat">Nodes: ${graph.stats.nodeCount}</div>
    <div class="stat">Edges: ${graph.stats.edgeCount}</div>
    <div class="stat">Broken links: ${graph.stats.brokenLinkCount}</div>
    <div class="stat">Orphans: ${graph.stats.orphanCount}</div>
    <div class="stat">Cycles: ${graph.stats.cycleCount}</div>
  </div>
  <div class="grid">
    <section>
      <h2>Nodes</h2>
      <pre><code>${escapeHtml(graph.nodes.map((node) => node.id).join("\\n"))}</code></pre>
    </section>
    <section>
      <h2>Edges</h2>
      <pre><code>${escapeHtml(graph.edges.map((edge) => `${edge.source} -> ${edge.target}`).join("\\n"))}</code></pre>
    </section>
  </div>
  <h2>Graph JSON</h2>
  <pre><code id="graph-json"></code></pre>
  <script type="application/json" id="graph-data">${graphJson}</script>
  <script>
    document.getElementById("graph-json").textContent = document.getElementById("graph-data").textContent;
  </script>
</body>
</html>
`;
}

function graphNode(concept: ConceptIR): GraphNodeIR {
  return {
    id: concept.id,
    path: concept.path,
    type: concept.type,
    title: concept.title,
    tags: concept.tags
  };
}

function reservedNode(file: IndexFileIR | LogFileIR, type: "Index" | "Log"): GraphNodeIR {
  return {
    id: conceptIdFromPath(file.path),
    path: file.path,
    type,
    title: type
  };
}

function graphEdge(link: LinkIR): GraphEdgeIR {
  return {
    source: link.sourceConceptId,
    target: link.targetConceptId ?? link.targetRaw,
    kind: "markdown-link",
    resolved: link.resolved,
    label: link.text
  };
}

function analyzeGraph(bundle: BundleIR, edges: GraphEdgeIR[]): GraphAnalysisIR {
  const conceptIds = new Set(bundle.concepts.map((concept) => concept.id));
  const pathsBySourceId = new Map([
    ...bundle.concepts.map((concept) => [concept.id, concept.path] as const),
    ...bundle.indexes.map((file) => [conceptIdFromPath(file.path), file.path] as const),
    ...bundle.logs.map((file) => [conceptIdFromPath(file.path), file.path] as const)
  ]);
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const brokenLinks: GraphAnalysisIR["brokenLinks"] = [];

  for (const edge of edges) {
    if (!edge.resolved) {
      brokenLinks.push({
        source: edge.source,
        targetRaw: edge.target,
        path: pathsBySourceId.get(edge.source)
      });
      continue;
    }

    if (!conceptIds.has(edge.target)) {
      continue;
    }

    incoming.set(edge.target, setAdd(incoming.get(edge.target), edge.source));
    if (conceptIds.has(edge.source)) {
      outgoing.set(edge.source, setAdd(outgoing.get(edge.source), edge.target));
    }
  }

  const backlinks = Object.fromEntries([...conceptIds].map((id) => [id, [...(incoming.get(id) ?? new Set<string>())].sort()]));
  const orphanConceptIds = [...conceptIds]
    .filter((id) => (incoming.get(id)?.size ?? 0) === 0 && (outgoing.get(id)?.size ?? 0) === 0)
    .sort();
  const cycles = findCycles(conceptIds, outgoing);
  const topReferencedConcepts = [...incoming.entries()]
    .map(([id, sources]) => ({ id, count: sources.size }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, 10);

  return {
    backlinks,
    brokenLinks,
    orphanConceptIds,
    isolatedClusterCount: countIsolatedClusters(conceptIds, outgoing, incoming),
    cycles,
    topReferencedConcepts
  };
}

function setAdd<T>(set: Set<T> | undefined, value: T): Set<T> {
  const next = set ?? new Set<T>();
  next.add(value);
  return next;
}

function findCycles(conceptIds: Set<string>, adjacency: Map<string, Set<string>>): string[][] {
  const cycles = new Map<string, string[]>();

  for (const start of conceptIds) {
    visit(start, []);
  }

  return [...cycles.values()].sort((a, b) => a.join(">").localeCompare(b.join(">")));

  function visit(id: string, stack: string[]): void {
    if (stack.includes(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      const key = [...new Set(cycle)].sort().join(">");
      cycles.set(key, cycle);
      return;
    }

    if (stack.length > conceptIds.size) {
      return;
    }

    for (const next of adjacency.get(id) ?? []) {
      visit(next, [...stack, id]);
    }
  }
}

function countIsolatedClusters(
  conceptIds: Set<string>,
  outgoing: Map<string, Set<string>>,
  incoming: Map<string, Set<string>>
): number {
  const visited = new Set<string>();
  let clusters = 0;

  for (const id of conceptIds) {
    if (visited.has(id)) {
      continue;
    }

    clusters += 1;
    const queue = [id];
    for (const current of queue) {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const next of outgoing.get(current) ?? []) {
        queue.push(next);
      }
      for (const next of incoming.get(current) ?? []) {
        queue.push(next);
      }
    }
  }

  return clusters;
}

function dotId(id: string): string {
  return `"${id.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
