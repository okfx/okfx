import { dirname, join, relative, resolve, sep } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { buildSearchIndex, loadBundle, type SearchIndexIR } from "@okfx/core";

import {
  ensureSafeGeneratedParent,
  inspectGeneratedPath,
  resolveGeneratedFiles,
  writeGeneratedFile
} from "../generated-files.js";
import { parseOutputFormat, terminalValue, writeOutput, type CliOutputFormat } from "../output.js";
import type { CliContext } from "../program.js";

type IndexMode = "full-text" | "vector" | "hybrid";

export function createIndexCommand(context: CliContext): Command {
  return new Command("index")
    .description("build a local search index")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--out <path>", "index output directory", ".okfx/index")
    .option("--mode <mode>", "index mode: full-text, vector, or hybrid", parseIndexMode, "full-text")
    .option("--vector-provider <name>", "explicit vector provider configuration for vector or hybrid modes")
    .option("--format <format>", "output format: pretty or json", parseOutputFormat, "pretty")
    .option("--json", "shortcut for --format json", false)
    .action(async (bundle: string, options: { out: string; mode: IndexMode; vectorProvider?: string; format: CliOutputFormat; json: boolean }) => {
      assertIndexModeSupported(options.mode, options.vectorProvider);
      const root = resolve(bundle);
      const loaded = await loadBundle(root);
      const index = buildSearchIndex(loaded);
      const requestedPath = join(resolve(root, options.out), "index.json");
      const relativePath = relative(root, requestedPath).split(sep).join("/");
      const [file] = resolveGeneratedFiles(root, [{
        path: relativePath,
        content: `${JSON.stringify(index, null, 2)}\n`
      }]);
      if (!file) {
        throw new Error("Could not resolve search index output path.");
      }
      await ensureSafeGeneratedParent(root, file.relativePath);
      await inspectGeneratedPath(root, file.relativePath);
      await writeGeneratedFile(file.path, file.content, true);
      const outDir = dirname(file.path);
      const format = options.json ? "json" : options.format;
      await writeOutput(formatIndex(index, outDir, format), undefined, context.io);
      context.setExitCode(0);
    });
}

function parseIndexMode(value: string): IndexMode {
  if (value === "full-text" || value === "vector" || value === "hybrid") {
    return value;
  }

  throw new InvalidArgumentError(`unsupported index mode "${value}"`);
}

function assertIndexModeSupported(mode: IndexMode, vectorProvider: string | undefined): void {
  if (mode === "full-text") {
    return;
  }

  if (!vectorProvider?.trim()) {
    throw new Error(`${mode} index mode requires explicit --vector-provider configuration.`);
  }

  throw new Error(`${mode} index mode requires a registered vector provider; this local build only includes full-text indexing.`);
}

function formatIndex(index: SearchIndexIR, outDir: string, format: CliOutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify({
      ok: true,
      outDir,
      documentCount: index.documents.length,
      termCount: Object.keys(index.terms).length,
      mode: index.mode
    }, null, 2)}\n`;
  }

  return `OKF search index built

Index:
  ${terminalValue(join(outDir, "index.json"))}

Documents:
  ${index.documents.length}

Terms:
  ${Object.keys(index.terms).length}
`;
}
