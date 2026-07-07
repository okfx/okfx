import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { Command, InvalidArgumentError } from "commander";

import {
  lintBundle,
  loadBundle,
  loadConfig,
  type BundleIR,
  type LintResult,
  type ResolvedOkfxConfig
} from "@okfx/core";

import { formatDiagnosticGroups, writeOutput } from "../output.js";
import type { CliContext } from "../program.js";

type LintFormat = "pretty" | "json" | "sarif";

export function createLintCommand(context: CliContext): Command {
  return new Command("lint")
    .description("run quality and style rules")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--format <format>", "output format: pretty, json, or sarif", parseLintFormat, "pretty")
    .option("--json", "shortcut for --format json", false)
    .option("--out <path>", "write output to a file")
    .option("--debug", "print debug diagnostics", false)
    .option("--trace", "print trace diagnostics", false)
    .option("--timings", "print runtime timings", false)
    .action(async (bundle: string, options: {
      format: LintFormat;
      json: boolean;
      out?: string;
      debug: boolean;
      trace: boolean;
      timings: boolean;
    }) => {
      const startedAt = performance.now();
      const root = resolve(bundle);
      const config = await loadConfig(root);
      const loaded = await loadBundle(root, { config, loadConfigFile: false });
      const result = lintBundle(loaded, { config });
      const format = options.json ? "json" : options.format;
      await writeOutput(formatLint(result, loaded, config, format), options.out, context.io);
      if (options.debug || options.trace || options.timings) {
        context.io.stderr.write(formatDebug({ root, config, loaded, result, elapsedMs: performance.now() - startedAt, trace: options.trace }));
      }
      context.setExitCode(result.ok ? 0 : 1);
    });
}

function parseLintFormat(value: string): LintFormat {
  if (value === "pretty" || value === "json" || value === "sarif") {
    return value;
  }

  throw new InvalidArgumentError(`unsupported lint format "${value}"`);
}

function formatLint(
  result: LintResult,
  bundle: BundleIR,
  config: ResolvedOkfxConfig,
  format: LintFormat
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

  if (format === "sarif") {
    return `${JSON.stringify(toSarif(result, bundle), null, 2)}\n`;
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

function toSarif(result: LintResult, bundle: BundleIR): unknown {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: {
        driver: {
          name: "okfx",
          informationUri: "https://github.com/okfx/okfx",
          rules: [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))].sort().map((code) => ({
            id: code,
            name: code,
            shortDescription: {
              text: code
            }
          }))
        }
      },
      originalUriBaseIds: {
        BUNDLE_ROOT: {
          uri: `file://${bundle.root.replace(/\/?$/, "/")}`
        }
      },
      results: result.diagnostics.map((diagnostic) => ({
        ruleId: diagnostic.code,
        level: sarifLevel(diagnostic.severity),
        message: {
          text: diagnostic.message
        },
        locations: diagnostic.path ? [{
          physicalLocation: {
            artifactLocation: {
              uri: diagnostic.path,
              uriBaseId: "BUNDLE_ROOT"
            },
            region: {
              startLine: diagnostic.location?.start.line ?? 1,
              startColumn: diagnostic.location?.start.column ?? 1
            }
          }
        }] : []
      }))
    }]
  };
}

function sarifLevel(severity: string): "error" | "warning" | "note" {
  if (severity === "error") {
    return "error";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "note";
}

function formatDebug(input: {
  root: string;
  config: ResolvedOkfxConfig;
  loaded: BundleIR;
  result: LintResult;
  elapsedMs: number;
  trace: boolean;
}): string {
  const trace = input.trace
    ? `  diagnostics:
${input.result.diagnostics.map((diagnostic) => `    - ${diagnostic.code} ${diagnostic.path ?? "(bundle)"}`).join("\n")}
`
    : "";

  return `okfx debug:
  root: ${input.root}
  config: ${input.config.configPath ?? "(default)"}
  filesScanned: ${input.loaded.stats.fileCount}
  conceptsParsed: ${input.loaded.stats.conceptCount}
  rulesExecuted: built-in
  cache: disabled
  plugins: none
  totalMs: ${input.elapsedMs.toFixed(1)}
${trace}`;
}
