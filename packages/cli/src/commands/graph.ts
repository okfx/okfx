import { resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { buildGraph, graphToCytoscape, graphToDot, graphToHtml, loadBundle, type OkfxGraphIR } from "@okfx/core";

import { writeOutput } from "../output.js";
import type { CliContext } from "../program.js";

type GraphFormat = "json" | "dot" | "html" | "cytoscape";

export function createGraphCommand(context: CliContext): Command {
  return new Command("graph")
    .description("build the OKF concept graph")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--format <format>", "output format: json, dot, html, or cytoscape", parseGraphFormat, "json")
    .option("--out <path>", "write output to a file")
    .action(async (bundle: string, options: { format: GraphFormat; out?: string }) => {
      const root = resolve(bundle);
      const loaded = await loadBundle(root);
      const graph = buildGraph(loaded);
      await writeOutput(formatGraph(graph, options.format), options.out, context.io);
      context.setExitCode(0);
    });
}

function parseGraphFormat(value: string): GraphFormat {
  if (value === "json" || value === "dot" || value === "html" || value === "cytoscape") {
    return value;
  }

  throw new InvalidArgumentError(`unsupported graph format "${value}"`);
}

function formatGraph(graph: OkfxGraphIR, format: GraphFormat): string {
  if (format === "dot") {
    return graphToDot(graph);
  }

  if (format === "html") {
    return graphToHtml(graph);
  }

  if (format === "cytoscape") {
    return `${JSON.stringify(graphToCytoscape(graph), null, 2)}\n`;
  }

  return `${JSON.stringify(graph, null, 2)}\n`;
}
