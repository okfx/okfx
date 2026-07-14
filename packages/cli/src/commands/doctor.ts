import { resolve } from "node:path";

import { Command } from "commander";

import {
  doctorBundle,
  loadBundle,
  loadConfig,
  type BundleIR,
  type DiagnosticIR,
  type DoctorResult,
  type ResolvedOkfxConfig
} from "@okfx/core";

import { formatDiagnostic, parseOutputFormat, terminalValue, writeOutput, type CliOutputFormat } from "../output.js";
import type { CliContext } from "../program.js";

export function createDoctorCommand(context: CliContext): Command {
  return new Command("doctor")
    .description("run production and agent-readiness checks")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--format <format>", "output format: pretty or json", parseOutputFormat, "pretty")
    .option("--json", "shortcut for --format json", false)
    .option("--out <path>", "write output to a file")
    .action(async (bundle: string, options: { format: CliOutputFormat; json: boolean; out?: string }) => {
      const root = resolve(bundle);
      const config = await loadConfig(root);
      const loaded = await loadBundle(root, { config, loadConfigFile: false });
      const result = doctorBundle(loaded, { config });
      const format = options.json ? "json" : options.format;
      await writeOutput(formatDoctor(result, loaded, config, format), options.out, context.io);
      context.setExitCode(result.ok ? 0 : 1);
    });
}

function formatDoctor(
  result: DoctorResult,
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
      score: result.score,
      summary: result.summary,
      counts: result.counts,
      diagnostics: result.diagnostics
    }, null, 2)}\n`;
  }

  const highImpact = result.highImpactDiagnostics.length > 0
    ? `\nHigh-impact issues:\n${formatDiagnosticList(result.highImpactDiagnostics)}\n`
    : "\nHigh-impact issues:\n  none\n";
  const advice = result.diagnostics.some((diagnostic) => diagnostic.severity === "advice")
    ? `\nAdvice:\n${formatDiagnosticList(result.diagnostics.filter((diagnostic) => diagnostic.severity === "advice"))}\n`
    : "";

  return `OKF Doctor

Bundle:
  root: ${terminalValue(bundle.root)}
  concepts: ${result.summary.conceptCount}
  links: ${result.summary.linkCount}
  broken links: ${result.summary.brokenLinkCount}
  orphan concepts: ${result.summary.orphanCount}
  cycles: ${result.summary.cycleCount}
  failOn: ${config.failOn}

Agent readiness:
  score: ${result.score}/100
  errors: ${result.counts.error}
  warnings: ${result.counts.warning}
  advice: ${result.counts.advice}
${highImpact}${advice}`;
}

function formatDiagnosticList(diagnostics: DiagnosticIR[]): string {
  return diagnostics
    .map(formatDiagnostic)
    .join("\n")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
