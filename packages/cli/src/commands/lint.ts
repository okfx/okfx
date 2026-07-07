import { resolve } from "node:path";

import { Command } from "commander";

import {
  lintBundle,
  loadBundle,
  loadConfig,
  type BundleIR,
  type LintResult,
  type ResolvedOkfxConfig
} from "@okfx/core";

import { formatDiagnosticGroups, parseOutputFormat, writeOutput, type CliOutputFormat } from "../output.js";
import type { CliContext } from "../program.js";

export function createLintCommand(context: CliContext): Command {
  return new Command("lint")
    .description("run quality and style rules")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--format <format>", "output format: pretty or json", parseOutputFormat, "pretty")
    .option("--json", "shortcut for --format json", false)
    .option("--out <path>", "write output to a file")
    .action(async (bundle: string, options: { format: CliOutputFormat; json: boolean; out?: string }) => {
      const root = resolve(bundle);
      const config = await loadConfig(root);
      const loaded = await loadBundle(root, { config, loadConfigFile: false });
      const result = lintBundle(loaded, { config });
      const format = options.json ? "json" : options.format;
      await writeOutput(formatLint(result, loaded, config, format), options.out, context.io);
      context.setExitCode(result.ok ? 0 : 1);
    });
}

function formatLint(
  result: LintResult,
  bundle: BundleIR,
  config: ResolvedOkfxConfig,
  format: CliOutputFormat
): string {
  if (format === "json") {
    return `${JSON.stringify({
      ok: result.ok,
      root: bundle.root,
      okfVersion: bundle.okfVersion,
      failOn: config.failOn,
      stats: bundle.stats,
      counts: result.counts,
      diagnostics: result.diagnostics
    }, null, 2)}\n`;
  }

  const status = result.ok ? "OKF lint passed" : "OKF lint found diagnostics";
  const diagnostics = result.diagnostics.length > 0
    ? `\n${formatDiagnosticGroups(result.diagnostics)}`
    : "";

  return `${status}

Bundle:
  root: ${bundle.root}
  files: ${bundle.stats.fileCount}
  concepts: ${bundle.stats.conceptCount}
  failOn: ${config.failOn}
  errors: ${result.counts.error}
  warnings: ${result.counts.warning}
  advice: ${result.counts.advice}
${diagnostics}
`;
}
