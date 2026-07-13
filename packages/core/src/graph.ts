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
  highDegreeHubs: Array<{
    id: string;
    incoming: number;
    outgoing: number;
    degree: number;
  }>;
  missingIndexSuggestions: Array<{
    path: string;
    reason: string;
  }>;
  staleSubgraphs: Array<{
    conceptIds: string[];
    latestTimestamp?: string;
    staleConceptCount: number;
  }>;
  topReferencedConcepts: Array<{
    id: string;
    count: number;
  }>;
}

export interface GraphOptions {
  highDegreeThreshold?: number;
  now?: Date;
  staleAfterDays?: number;
}

export interface OkfxGraphIR extends GraphIR {
  analysis: GraphAnalysisIR;
}

export interface CytoscapeGraphIR {
  elements: {
    nodes: Array<{
      data: {
        id: string;
        label: string;
        type: string;
        path?: string;
        tags?: string[];
      };
    }>;
    edges: Array<{
      data: {
        id: string;
        source: string;
        target: string;
        kind: GraphEdgeIR["kind"];
        label?: string;
        resolved: boolean;
      };
    }>;
  };
}

export function buildGraph(bundle: BundleIR, options: GraphOptions = {}): OkfxGraphIR {
  const nodes = [
    ...bundle.concepts.map(graphNode),
    ...bundle.indexes.map((file) => reservedNode(file, "Index")),
    ...bundle.logs.map((file) => reservedNode(file, "Log"))
  ];
  const edges = [
    ...bundle.links
      .filter((link) => link.kind === "internal")
      .map(graphEdge),
    ...bundle.concepts.flatMap(metadataEdges)
  ];
  const analysis = analyzeGraph(bundle, edges, options);

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

export function graphToCytoscape(graph: OkfxGraphIR): CytoscapeGraphIR {
  const nodesById = new Map<string, CytoscapeGraphIR["elements"]["nodes"][number]>(graph.nodes.map((node) => [node.id, {
    data: {
      id: node.id,
      label: node.title ?? node.id,
      type: node.type,
      path: node.path,
      tags: node.tags
    }
  }]));

  for (const edge of graph.edges) {
    if (!nodesById.has(edge.target)) {
      nodesById.set(edge.target, {
        data: {
          id: edge.target,
          label: edge.label ?? labelFromTarget(edge.target),
          type: edge.resolved ? edge.kind : "Unresolved"
        }
      });
    }
  }

  return {
    elements: {
      nodes: [...nodesById.values()].sort((a, b) => a.data.id.localeCompare(b.data.id)),
      edges: graph.edges.map((edge, index) => ({
        data: {
          id: `${edge.source}->${edge.target}:${edge.kind}:${index}`,
          source: edge.source,
          target: edge.target,
          kind: edge.kind,
          label: edge.label,
          resolved: edge.resolved
        }
      }))
    }
  };
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

function metadataEdges(concept: ConceptIR): GraphEdgeIR[] {
  return [
    ...uniqueNonEmpty(resourceValues(concept)).map((resource) => ({
      source: concept.id,
      target: `resource:${resource}`,
      kind: "resource" as const,
      resolved: true,
      label: resource
    })),
    ...uniqueNonEmpty(concept.tags ?? []).map((tag) => ({
      source: concept.id,
      target: `tag:${tag}`,
      kind: "tag" as const,
      resolved: true,
      label: tag
    }))
  ];
}

function resourceValues(concept: ConceptIR): string[] {
  if (Array.isArray(concept.resource)) {
    return concept.resource;
  }

  return concept.resource ? [concept.resource] : [];
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function analyzeGraph(bundle: BundleIR, edges: GraphEdgeIR[], options: GraphOptions): GraphAnalysisIR {
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
  const clusters = connectedConceptClusters(conceptIds, outgoing, incoming);
  const cycles = findCycles(conceptIds, outgoing);
  const highDegreeHubs = findHighDegreeHubs(conceptIds, incoming, outgoing, options.highDegreeThreshold ?? 25);
  const topReferencedConcepts = [...incoming.entries()]
    .map(([id, sources]) => ({ id, count: sources.size }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, 10);

  return {
    backlinks,
    brokenLinks,
    orphanConceptIds,
    isolatedClusterCount: clusters.length,
    cycles,
    highDegreeHubs,
    missingIndexSuggestions: findMissingIndexSuggestions(bundle),
    staleSubgraphs: findStaleSubgraphs(bundle, clusters, options.now ?? new Date(), options.staleAfterDays ?? 180),
    topReferencedConcepts
  };
}

function setAdd<T>(set: Set<T> | undefined, value: T): Set<T> {
  const next = set ?? new Set<T>();
  next.add(value);
  return next;
}

function findCycles(conceptIds: Set<string>, adjacency: Map<string, Set<string>>): string[][] {
  const reverseAdjacency = new Map<string, Set<string>>();
  for (const id of conceptIds) {
    reverseAdjacency.set(id, new Set());
  }
  for (const [source, targets] of adjacency) {
    for (const target of targets) {
      if (conceptIds.has(source) && conceptIds.has(target)) {
        reverseAdjacency.get(target)?.add(source);
      }
    }
  }

  const finishOrder: string[] = [];
  const visited = new Set<string>();
  for (const start of [...conceptIds].sort()) {
    if (visited.has(start)) {
      continue;
    }
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: start, expanded: false }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        break;
      }
      if (current.expanded) {
        finishOrder.push(current.id);
        continue;
      }
      if (visited.has(current.id)) {
        continue;
      }
      visited.add(current.id);
      stack.push({ id: current.id, expanded: true });
      const neighbors = [...(adjacency.get(current.id) ?? [])]
        .filter((id) => conceptIds.has(id))
        .sort()
        .reverse();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          stack.push({ id: neighbor, expanded: false });
        }
      }
    }
  }

  const assigned = new Set<string>();
  const components: string[][] = [];
  for (const start of finishOrder.reverse()) {
    if (assigned.has(start)) {
      continue;
    }
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        break;
      }
      component.push(current);
      for (const neighbor of reverseAdjacency.get(current) ?? []) {
        if (!assigned.has(neighbor)) {
          assigned.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    components.push(component.sort());
  }

  return components
    .filter((component) => component.length > 1 || adjacency.get(component[0])?.has(component[0]))
    .map((component) => representativeCycle(component, adjacency))
    .sort((a, b) => a.join(">").localeCompare(b.join(">")));
}

function representativeCycle(component: string[], adjacency: Map<string, Set<string>>): string[] {
  const members = new Set(component);
  const start = component[0];
  if (component.length === 1) {
    return [start, start];
  }

  const firstSteps = [...(adjacency.get(start) ?? [])]
    .filter((id) => id !== start && members.has(id))
    .sort();
  for (const firstStep of firstSteps) {
    const path = findPath(firstStep, start, members, adjacency);
    if (path) {
      return [start, ...path];
    }
  }

  throw new Error(`Could not construct a representative cycle for strongly connected component: ${component.join(", ")}`);
}

function findPath(
  from: string,
  to: string,
  members: Set<string>,
  adjacency: Map<string, Set<string>>
): string[] | undefined {
  const parents = new Map<string, string | undefined>([[from, undefined]]);
  const queue = [from];
  for (const current of queue) {
    if (current === to) {
      const path: string[] = [];
      let cursor: string | undefined = current;
      while (cursor !== undefined) {
        path.push(cursor);
        cursor = parents.get(cursor);
      }
      return path.reverse();
    }
    for (const neighbor of [...(adjacency.get(current) ?? [])].filter((id) => members.has(id)).sort()) {
      if (!parents.has(neighbor)) {
        parents.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }
  return undefined;
}

function findHighDegreeHubs(
  conceptIds: Set<string>,
  incoming: Map<string, Set<string>>,
  outgoing: Map<string, Set<string>>,
  threshold: number
): GraphAnalysisIR["highDegreeHubs"] {
  if (threshold <= 0) {
    return [];
  }

  return [...conceptIds]
    .map((id) => {
      const incomingCount = incoming.get(id)?.size ?? 0;
      const outgoingCount = outgoing.get(id)?.size ?? 0;
      return {
        id,
        incoming: incomingCount,
        outgoing: outgoingCount,
        degree: incomingCount + outgoingCount
      };
    })
    .filter((hub) => hub.degree >= threshold)
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
}

function findMissingIndexSuggestions(bundle: BundleIR): GraphAnalysisIR["missingIndexSuggestions"] {
  const conceptDirs = new Set(bundle.concepts.map((concept) => pathDir(concept.path)));
  if (conceptDirs.size === 0) {
    conceptDirs.add("");
  }

  const indexDirs = new Set(bundle.indexes.map((index) => pathDir(index.path)));
  return [...conceptDirs]
    .filter((dir) => !indexDirs.has(dir))
    .sort()
    .map((dir) => ({
      path: indexPathForDir(dir),
      reason: "Directory has concepts but no index.md entrypoint."
    }));
}

function findStaleSubgraphs(
  bundle: BundleIR,
  clusters: string[][],
  now: Date,
  staleAfterDays: number
): GraphAnalysisIR["staleSubgraphs"] {
  const conceptsById = new Map(bundle.concepts.map((concept) => [concept.id, concept]));
  const staleAfterMs = staleAfterDays * 24 * 60 * 60 * 1000;

  return clusters.flatMap((conceptIds) => {
    const timestamped = conceptIds
      .map((id) => conceptsById.get(id))
      .map((concept) => concept?.timestamp)
      .filter((timestamp): timestamp is string => timestamp !== undefined)
      .map((timestamp) => ({ timestamp, parsed: Date.parse(timestamp) }))
      .filter((entry) => !Number.isNaN(entry.parsed));
    if (timestamped.length === 0) {
      return [];
    }

    const stale = timestamped.filter((entry) => now.getTime() - entry.parsed > staleAfterMs);
    if (stale.length === 0 || stale.length !== timestamped.length) {
      return [];
    }

    const latest = [...timestamped].sort((a, b) => b.parsed - a.parsed)[0];
    return [{
      conceptIds,
      latestTimestamp: latest?.timestamp,
      staleConceptCount: stale.length
    }];
  });
}

function connectedConceptClusters(
  conceptIds: Set<string>,
  outgoing: Map<string, Set<string>>,
  incoming: Map<string, Set<string>>
): string[][] {
  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const id of [...conceptIds].sort()) {
    if (visited.has(id)) {
      continue;
    }

    const cluster: string[] = [];
    const queue = [id];
    for (const current of queue) {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      cluster.push(current);
      for (const next of outgoing.get(current) ?? []) {
        queue.push(next);
      }
      for (const next of incoming.get(current) ?? []) {
        queue.push(next);
      }
    }
    clusters.push(cluster.sort());
  }

  return clusters;
}

function dotId(id: string): string {
  return JSON.stringify(id);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function labelFromTarget(target: string): string {
  return target.replace(/^(resource|tag):/, "");
}

function pathDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function indexPathForDir(dir: string): string {
  return dir ? `${dir}/index.md` : "index.md";
}
