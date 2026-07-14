import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  backlinksForConcept,
  buildGraph,
  buildSearchIndex,
  compareStrings,
  diffBundles,
  doctorBundle,
  lintBundleWithPlugins,
  loadBundle,
  loadConfig,
  loadConfiguredPlugins,
  okfxVersion,
  tokenizeSearchText,
  validateBundle,
  type BundleIR,
  type BundleDiffIR,
  type ConceptIR,
  type LintResult,
  type ResolvedOkfxConfig
} from "@okfx/core";

export interface OkfMcpServerOptions {
  root: string;
  readonly?: boolean;
  config?: ResolvedOkfxConfig;
}

const BASE_MCP_TOOLS = [
  "okf_list_bundles",
  "okf_search_concepts",
  "okf_get_concept",
  "okf_explain_diff"
] as const;

const GRAPH_MCP_TOOLS = [
  "okf_get_neighbors",
  "okf_get_backlinks",
  "okf_get_graph"
] as const;

const DIAGNOSTIC_MCP_TOOLS = [
  "okf_validate_bundle",
  "okf_lint_bundle",
  "okf_get_diagnostics"
] as const;

export const OKF_MCP_TOOLS = [
  ...BASE_MCP_TOOLS,
  ...GRAPH_MCP_TOOLS,
  ...DIAGNOSTIC_MCP_TOOLS
] as const;

export const OKF_MCP_PROMPTS = [
  "review_okf_changes",
  "draft_okf_concept",
  "improve_agent_readiness",
  "explain_metric_context",
  "trace_table_to_metric"
] as const;

export interface ConceptSearchResult {
  id: string;
  path: string;
  title?: string;
  description?: string;
  type: string;
  score: number;
}

export interface BundleListEntry {
  id: "current";
  root: string;
  okfVersion?: string;
  conceptCount: number;
  linkCount: number;
}

export interface DiffExplanation {
  beforeRoot: string;
  afterRoot: string;
  hasChanges: boolean;
  summary: string;
  highlights: string[];
  diff: BundleDiffIR;
}

export interface OkfBundleApi {
  load(): Promise<BundleIR>;
  listBundles(): Promise<BundleListEntry[]>;
  searchConcepts(query: string, limit?: number): Promise<ConceptSearchResult[]>;
  getConcept(id: string): Promise<ConceptIR | undefined>;
  getNeighbors(id: string): Promise<{ outgoing: string[]; incoming: string[] }>;
  getBacklinks(id: string): Promise<string[]>;
  getGraph(): Promise<ReturnType<typeof buildGraph>>;
  explainDiff(comparisonRoot: string, direction?: "baseline-to-current" | "current-to-comparison"): Promise<DiffExplanation>;
  getDiagnostics(): Promise<ReturnType<typeof doctorBundle>>;
  validate(): Promise<ReturnType<typeof validateBundle>>;
  lint(): Promise<LintResult>;
}

export function getOkfMcpTools(config: Pick<ResolvedOkfxConfig, "mcp">): string[] {
  return [
    ...BASE_MCP_TOOLS,
    ...(config.mcp.exposeGraph ? GRAPH_MCP_TOOLS : []),
    ...(config.mcp.exposeDiagnostics ? DIAGNOSTIC_MCP_TOOLS : [])
  ];
}

export function createOkfBundleApi(root: string, fixedConfig?: ResolvedOkfxConfig): OkfBundleApi {
  const currentRoot = resolve(root);
  const loadContext = async () => {
    const config = fixedConfig ?? await loadConfig(currentRoot);
    const bundle = await loadBundle(currentRoot, { config, loadConfigFile: false });
    return { bundle, config };
  };

  return {
    load: async () => (await loadContext()).bundle,
    async listBundles() {
      const { bundle } = await loadContext();
      return [{
        id: "current",
        root: currentRoot,
        okfVersion: bundle.okfVersion,
        conceptCount: bundle.stats.conceptCount,
        linkCount: bundle.stats.linkCount
      }];
    },
    async searchConcepts(query, limit = 10) {
      const { bundle } = await loadContext();
      const index = buildSearchIndex(bundle);
      const terms = tokenizeSearchText(query);
      const scores = new Map<string, number>();

      for (const term of terms) {
        const ids = Object.hasOwn(index.terms, term) ? index.terms[term]! : [];
        for (const id of ids) {
          scores.set(id, (scores.get(id) ?? 0) + 1);
        }
      }

      if (terms.length === 0) {
        for (const document of index.documents) {
          scores.set(document.id, 1);
        }
      }

      const conceptsById = new Map(bundle.concepts.map((concept) => [concept.id, concept]));
      return [...scores.entries()]
        .map(([id, score]) => ({ concept: conceptsById.get(id), score }))
        .filter((entry): entry is { concept: ConceptIR; score: number } => entry.concept !== undefined)
        .map(({ concept, score }) => ({
          id: concept.id,
          path: concept.path,
          title: concept.title,
          description: concept.description,
          type: concept.type,
          score
        }))
        .sort((a, b) => b.score - a.score || compareStrings(a.id, b.id))
        .slice(0, limit);
    },
    async getConcept(id) {
      const { bundle } = await loadContext();
      return bundle.concepts.find((concept) => concept.id === id);
    },
    async getNeighbors(id) {
      const graph = buildGraph((await loadContext()).bundle);
      return {
        outgoing: [...new Set(graph.edges
          .filter((edge) => edge.resolved && edge.source === id)
          .map((edge) => edge.target))]
          .sort(compareStrings),
        incoming: backlinksForConcept(graph, id)
      };
    },
    async getBacklinks(id) {
      const graph = buildGraph((await loadContext()).bundle);
      return backlinksForConcept(graph, id);
    },
    async getGraph() {
      return buildGraph((await loadContext()).bundle);
    },
    async explainDiff(comparisonRoot, direction = "baseline-to-current") {
      const safeComparisonRoot = await resolveSafeComparisonRoot(currentRoot, comparisonRoot);
      const { bundle: current, config } = await loadContext();
      const comparison = await loadBundle(safeComparisonRoot, {
        config,
        loadConfigFile: false
      });
      const before = direction === "baseline-to-current" ? comparison : current;
      const after = direction === "baseline-to-current" ? current : comparison;
      const diff = diffBundles(before, after);

      return {
        beforeRoot: before.root,
        afterRoot: after.root,
        hasChanges: hasDiffChanges(diff),
        summary: summarizeDiff(diff),
        highlights: diffHighlights(diff),
        diff
      };
    },
    async getDiagnostics() {
      const { bundle, config } = await loadContext();
      return doctorBundle(bundle, { config });
    },
    async validate() {
      return validateBundle((await loadContext()).bundle);
    },
    async lint() {
      const { bundle, config } = await loadContext();
      const pluginLoad = await loadConfiguredPlugins(currentRoot, config);
      return lintBundleWithPlugins(bundle, {
        config,
        plugins: pluginLoad.plugins,
        pluginDiagnostics: pluginLoad.diagnostics
      });
    }
  };
}

export async function createOkfMcpServer(options: OkfMcpServerOptions): Promise<McpServer> {
  const root = resolve(options.root);
  const config = options.config ?? await loadConfig(root);
  const api = createOkfBundleApi(root, config);
  const server = new McpServer({
    name: "okfx",
    version: okfxVersion
  });

  registerResources(server, api, config);
  registerTools(server, api, config);
  registerPrompts(server);

  return server;
}

export async function startStdioServer(options: OkfMcpServerOptions): Promise<void> {
  const server = await createOkfMcpServer(options);
  await server.connect(new StdioServerTransport());
}

function registerResources(server: McpServer, api: OkfBundleApi, config: ResolvedOkfxConfig): void {
  server.registerResource("current-bundle", "okf://bundle/current", {
    title: "Current OKF bundle",
    mimeType: "application/json"
  }, async (uri) => jsonResource(uri.href, await api.load()));

  if (config.mcp.exposeGraph) {
    server.registerResource("current-graph", "okf://graph/current", {
      title: "Current OKF graph",
      mimeType: "application/json"
    }, async (uri) => jsonResource(uri.href, await api.getGraph()));
  }

  if (config.mcp.exposeDiagnostics) {
    server.registerResource("current-diagnostics", "okf://diagnostics/current", {
      title: "Current OKF diagnostics",
      mimeType: "application/json"
    }, async (uri) => jsonResource(uri.href, await api.getDiagnostics()));
  }

  server.registerResource("concept", new ResourceTemplate("okf://concept/{id}", {
    list: async () => {
      const bundle = await api.load();
      return {
        resources: bundle.concepts.map((concept) => ({
          uri: `okf://concept/${encodeURIComponent(concept.id)}`,
          name: concept.id,
          title: concept.title,
          mimeType: "application/json"
        }))
      };
    }
  }), {
    title: "OKF concept",
    mimeType: "application/json"
  }, async (uri, variables) => {
    const id = decodeURIComponent(String(variables.id));
    return jsonResource(uri.href, await api.getConcept(id) ?? { error: "concept not found", id });
  });
}

function registerTools(server: McpServer, api: OkfBundleApi, config: ResolvedOkfxConfig): void {
  server.registerTool("okf_list_bundles", {
    title: "List OKF bundles",
    description: "List bundles available to this local MCP server."
  }, async () => jsonTool(await api.listBundles()));

  server.registerTool("okf_search_concepts", {
    title: "Search OKF concepts",
    description: "Search concepts in the current OKF bundle using the local full-text index.",
    inputSchema: z.object({
      query: z.string().default(""),
      limit: z.number().int().min(1).max(50).default(10)
    })
  }, async ({ query, limit }) => jsonTool(await api.searchConcepts(query, limit)));

  server.registerTool("okf_get_concept", {
    title: "Get OKF concept",
    description: "Read a concept by concept ID.",
    inputSchema: z.object({
      id: z.string()
    })
  }, async ({ id }) => jsonTool(await api.getConcept(id) ?? { error: "concept not found", id }));

  if (config.mcp.exposeGraph) {
    server.registerTool("okf_get_neighbors", {
      title: "Get concept neighbors",
      description: "Return incoming and outgoing graph neighbors for a concept.",
      inputSchema: z.object({
        id: z.string()
      })
    }, async ({ id }) => jsonTool(await api.getNeighbors(id)));

    server.registerTool("okf_get_backlinks", {
      title: "Get concept backlinks",
      description: "Return backlinks for a concept.",
      inputSchema: z.object({
        id: z.string()
      })
    }, async ({ id }) => jsonTool(await api.getBacklinks(id)));

    server.registerTool("okf_get_graph", {
      title: "Get OKF graph",
      description: "Return the current concept graph."
    }, async () => jsonTool(await api.getGraph()));
  }

  if (config.mcp.exposeDiagnostics) {
    server.registerTool("okf_validate_bundle", {
      title: "Validate OKF bundle",
      description: "Run OKF validation diagnostics."
    }, async () => jsonTool(await api.validate()));

    server.registerTool("okf_lint_bundle", {
      title: "Lint OKF bundle",
      description: "Run OKF lint diagnostics."
    }, async () => jsonTool(await api.lint()));
  }

  server.registerTool("okf_explain_diff", {
    title: "Explain OKF semantic diff",
    description: "Compare the current local bundle with another local bundle root and return a deterministic semantic diff summary.",
    inputSchema: z.object({
      comparisonRoot: z.string(),
      direction: z.enum(["baseline-to-current", "current-to-comparison"]).default("baseline-to-current")
    })
  }, async ({ comparisonRoot, direction }) => jsonTool(await api.explainDiff(comparisonRoot, direction)));

  if (config.mcp.exposeDiagnostics) {
    server.registerTool("okf_get_diagnostics", {
      title: "Get OKF diagnostics",
      description: "Return doctor diagnostics and agent-readiness score."
    }, async () => jsonTool(await api.getDiagnostics()));
  }
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt("review_okf_changes", {
    title: "Review OKF changes",
    description: "Review OKF bundle diagnostics, graph changes, and agent-readiness risks."
  }, () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Review the current OKF bundle for validation, lint, graph, security, and agent-readiness issues. Prioritize concrete diagnostics and missing context."
      }
    }]
  }));

  server.registerPrompt("improve_agent_readiness", {
    title: "Improve agent readiness",
    description: "Suggest improvements that make the OKF bundle easier for agents to retrieve and use."
  }, () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Use OKF diagnostics, backlinks, and concept content to suggest specific changes that improve agent readiness."
      }
    }]
  }));

  server.registerPrompt("draft_okf_concept", {
    title: "Draft OKF concept",
    description: "Draft a new OKF Markdown concept with valid frontmatter and useful links."
  }, () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Draft a new OKF concept for the requested subject. Include YAML frontmatter with type, title, description, tags, and useful Markdown sections. Link to related concepts when IDs are available."
      }
    }]
  }));

  server.registerPrompt("explain_metric_context", {
    title: "Explain metric context",
    description: "Explain a metric concept using linked tables, owners, and runbooks."
  }, () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Explain the selected metric concept using its description, source links, upstream tables, downstream consumers, and nearby runbook context. Call OKF tools to inspect neighbors and backlinks before answering."
      }
    }]
  }));

  server.registerPrompt("trace_table_to_metric", {
    title: "Trace table to metric",
    description: "Trace how a table concept contributes to metrics through graph links."
  }, () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Trace the selected table concept to related metric concepts. Use graph neighbors, backlinks, and search results to explain the path and call out missing links."
      }
    }]
  }));
}

function jsonTool(value: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: `${JSON.stringify(value, null, 2)}\n`
    }]
  };
}

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: `${JSON.stringify(value, null, 2)}\n`
    }]
  };
}

async function resolveSafeComparisonRoot(currentRoot: string, comparisonRoot: string): Promise<string> {
  const allowedBase = dirname(currentRoot);
  const resolved = isAbsolute(comparisonRoot)
    ? resolve(comparisonRoot)
    : resolve(currentRoot, comparisonRoot);
  const [canonicalBase, canonicalRoot] = await Promise.all([
    realpath(allowedBase),
    realpath(resolved)
  ]);
  const relativePath = relative(canonicalBase, canonicalRoot);

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`comparisonRoot must stay under ${allowedBase}`);
  }

  return canonicalRoot;
}

function hasDiffChanges(diff: BundleDiffIR): boolean {
  return diff.stats.addedCount + diff.stats.removedCount + diff.stats.renamedCount + diff.stats.changedCount > 0
    || diff.stats.readinessChanged;
}

function summarizeDiff(diff: BundleDiffIR): string {
  if (!hasDiffChanges(diff)) {
    return "No semantic changes.";
  }

  return [
    `${diff.stats.addedCount} added`,
    `${diff.stats.removedCount} removed`,
    `${diff.stats.renamedCount} renamed`,
    `${diff.stats.changedCount} changed`
  ].join(", ");
}

function diffHighlights(diff: BundleDiffIR): string[] {
  return [
    ...diff.addedConcepts.slice(0, 5).map((id) => `Added concept: ${id}`),
    ...diff.removedConcepts.slice(0, 5).map((id) => `Removed concept: ${id}`),
    ...diff.renamedConcepts.slice(0, 5).map((entry) => `Renamed concept: ${entry.from} -> ${entry.to}`),
    ...diff.changedConcepts.slice(0, 5).map((entry) => `Changed concept: ${entry.id} (${entry.changes.join(", ")})`)
  ];
}
