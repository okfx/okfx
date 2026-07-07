import { resolve } from "node:path";

import { Command } from "commander";

import {
  loadBundle,
  validateBundle,
  type BundleIR,
  type DiagnosticIR,
  type ValidationResult
} from "@okfx/core";

import { parseOutputFormat, writeOutput, type CliOutputFormat } from "../output.js";
import type { CliContext } from "../program.js";

export function createValidateCommand(context: CliContext): Command {
  return new Command("validate")
    .description("check OKF conformance")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--format <format>", "output format: pretty or json", parseOutputFormat, "pretty")
    .option("--json", "shortcut for --format json", false)
    .option("--out <path>", "write output to a file")
    .action(async (bundle: string, options: { format: CliOutputFormat; json: boolean; out?: string }) => {
      const root = resolve(bundle);
      const loaded = await loadBundle(root);
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

${formatDiagnosticGroups(result.diagnostics)}`;
}

function formatDiagnosticGroups(diagnostics: DiagnosticIR[]): string {
  const groups = new Map<string, DiagnosticIR[]>();
  for (const diagnostic of diagnostics) {
    groups.set(diagnostic.severity, [...(groups.get(diagnostic.severity) ?? []), diagnostic]);
  }

  return [...groups.entries()]
    .map(([severity, entries]) => `${severity}s:
${entries.map(formatDiagnostic).join("\n")}`)
    .join("\n\n");
}

function formatDiagnostic(diagnostic: DiagnosticIR): string {
  const location = diagnostic.location?.start;
  const path = diagnostic.path
    ? `${diagnostic.path}${location ? `:${location.line}:${location.column}` : ""}`
    : "(bundle)";

  return `  ${diagnostic.code}
    ${path}
    ${diagnostic.message}`;
}
