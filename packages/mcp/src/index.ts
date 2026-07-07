import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  buildGraph,
  buildSearchIndex,
  doctorBundle,
  lintBundle,
  loadBundle,
  okfxVersion,
  validateBundle,
  type BundleIR,
  type ConceptIR
} from "@okfx/core";

export interface OkfMcpServerOptions {
  root: string;
  readonly?: boolean;
}

export interface ConceptSearchResult {
  id: string;
  path: string;
  title?: string;
  description?: string;
  type: string;
  score: number;
}

export interface OkfBundleApi {
  load(): Promise<BundleIR>;
  searchConcepts(query: string, limit?: number): Promise<ConceptSearchResult[]>;
  getConcept(id: string): Promise<ConceptIR | undefined>;
  getNeighbors(id: string): Promise<{ outgoing: string[]; incoming: string[] }>;
  getBacklinks(id: string): Promise<string[]>;
  getGraph(): Promise<ReturnType<typeof buildGraph>>;
  getDiagnostics(): Promise<ReturnType<typeof doctorBundle>>;
  validate(): Promise<ReturnType<typeof validateBundle>>;
  lint(): Promise<ReturnType<typeof lintBundle>>;
}

export function createOkfBundleApi(root: string): OkfBundleApi {
  return {
    load: () => loadBundle(root),
    async searchConcepts(query, limit = 10) {
      const bundle = await loadBundle(root);
      const index = buildSearchIndex(bundle);
      const terms = tokenize(query);
      const scores = new Map<string, number>();

      for (const term of terms) {
        for (const id of index.terms[term] ?? []) {
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
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async getConcept(id) {
      const bundle = await loadBundle(root);
      return bundle.concepts.find((concept) => concept.id === id);
    },
    async getNeighbors(id) {
      const graph = buildGraph(await loadBundle(root));
      return {
        outgoing: graph.edges
          .filter((edge) => edge.resolved && edge.source === id)
          .map((edge) => edge.target)
          .sort(),
        incoming: graph.analysis.backlinks[id] ?? []
      };
    },
    async getBacklinks(id) {
      const graph = buildGraph(await loadBundle(root));
      return graph.analysis.backlinks[id] ?? [];
    },
    async getGraph() {
      return buildGraph(await loadBundle(root));
    },
    async getDiagnostics() {
      return doctorBundle(await loadBundle(root));
    },
    async validate() {
      return validateBundle(await loadBundle(root));
    },
    async lint() {
      return lintBundle(await loadBundle(root));
    }
  };
}

export function createOkfMcpServer(options: OkfMcpServerOptions): McpServer {
  const api = createOkfBundleApi(options.root);
  const server = new McpServer({
    name: "okfx",
    version: okfxVersion
  });

  registerResources(server, api);
  registerTools(server, api);
  registerPrompts(server);

  return server;
}

export async function startStdioServer(options: OkfMcpServerOptions): Promise<void> {
  const server = createOkfMcpServer(options);
  await server.connect(new StdioServerTransport());
}

function registerResources(server: McpServer, api: OkfBundleApi): void {
  server.registerResource("current-bundle", "okf://bundle/current", {
    title: "Current OKF bundle",
    mimeType: "application/json"
  }, async (uri) => jsonResource(uri.href, await api.load()));

  server.registerResource("current-graph", "okf://graph/current", {
    title: "Current OKF graph",
    mimeType: "application/json"
  }, async (uri) => jsonResource(uri.href, await api.getGraph()));

  server.registerResource("current-diagnostics", "okf://diagnostics/current", {
    title: "Current OKF diagnostics",
    mimeType: "application/json"
  }, async (uri) => jsonResource(uri.href, await api.getDiagnostics()));

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

function registerTools(server: McpServer, api: OkfBundleApi): void {
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

  server.registerTool("okf_validate_bundle", {
    title: "Validate OKF bundle",
    description: "Run OKF validation diagnostics."
  }, async () => jsonTool(await api.validate()));

  server.registerTool("okf_lint_bundle", {
    title: "Lint OKF bundle",
    description: "Run OKF lint diagnostics."
  }, async () => jsonTool(await api.lint()));

  server.registerTool("okf_get_diagnostics", {
    title: "Get OKF diagnostics",
    description: "Return doctor diagnostics and agent-readiness score."
  }, async () => jsonTool(await api.getDiagnostics()));
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

function tokenize(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2))];
}
