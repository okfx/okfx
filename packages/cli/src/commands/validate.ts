import { resolve } from "node:path";

import { Command } from "commander";

import {
  loadBundle,
  validateBundle,
  type BundleIR,
  type ValidationResult
} from "@okfx/core";

import { formatDiagnosticGroups, parseOutputFormat, writeOutput, type CliOutputFormat } from "../output.js";
import type { CliContext } from "../program.js";

export function createValidateCommand(context: CliContext): Command {
  return new Command("validate")
    .description("check OKF conformance")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--format <format>", "output format: pretty or json", parseOutputFormat, "pretty")
    .option("--json", "shortcut for --format json", false)
    .option("--out <path>", "write output to a file")
    .option("--okf-version <version>", "override expected OKF version compatibility", undefined)
    .action(async (bundle: string, options: { format: CliOutputFormat; json: boolean; out?: string; okfVersion?: string }) => {
      const root = resolve(bundle);
      const loaded = await loadBundle(root, {
        config: options.okfVersion ? { okfVersion: options.okfVersion } : undefined
      });
      const result = validateBundle(loaded);
      const format = options.json ? "json" : options.format;
      await writeOutput(formatValidation(result, loaded, format), options.out, context.io);
      context.setExitCode(result.ok ? 0 : 1);
    });
}

function formatValidation(result: ValidationResult, bundle: BundleIR, format: CliOutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify({
      ok: result.ok,
      root: bundle.root,
      okfVersion: bundle.okfVersion,
      stats: bundle.stats,
      counts: result.counts,
      diagnostics: result.diagnostics
    }, null, 2)}\n`;
  }

  if (result.ok) {
    return `OKF validation passed

Bundle:
  root: ${bundle.root}
  files: ${bundle.stats.fileCount}
  concepts: ${bundle.stats.conceptCount}
  diagnostics: ${result.diagnostics.length}
`;
  }

  return `OKF validation failed

${formatDiagnosticGroups(result.diagnostics)}
`;
}
