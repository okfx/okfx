import { resolve } from "node:path";

import { Command } from "commander";

import { formatBundle, type FormatBundleResult } from "@okfxjs/core";

import { formatDiagnosticGroups, parseOutputFormat, terminalValue, writeOutput, type CliOutputFormat } from "../output.js";
import type { CliContext } from "../program.js";

export function createFmtCommand(context: CliContext): Command {
  return new Command("fmt")
    .description("format OKF Markdown and frontmatter")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--check", "check whether files are formatted without writing", false)
    .option("--format <format>", "output format: pretty or json", parseOutputFormat, "pretty")
    .option("--json", "shortcut for --format json", false)
    .option("--out <path>", "write command output to a file")
    .action(async (bundle: string, options: { check: boolean; format: CliOutputFormat; json: boolean; out?: string }) => {
      const root = resolve(bundle);
      const result = await formatBundle(root, { check: options.check });
      const format = options.json ? "json" : options.format;
      await writeOutput(formatFmt(result, root, format), options.out, context.io);
      context.setExitCode(result.ok ? 0 : 1);
    });
}

function formatFmt(result: FormatBundleResult, root: string, format: CliOutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify({
      ok: result.ok,
      root,
      checked: result.checked,
      changed: result.changed,
      files: result.files,
      diagnostics: result.diagnostics
    }, null, 2)}\n`;
  }

  const changed = result.files.filter((file) => file.changed).map((file) => file.path);
  const status = result.checked
    ? result.changed ? "OKF format check failed" : "OKF format check passed"
    : result.changed ? "OKF files formatted" : "OKF files already formatted";
  const changedList = changed.length > 0
    ? `\nChanged files:\n${changed.map((path) => `  ${terminalValue(path)}`).join("\n")}\n`
    : "";
  const diagnostics = result.diagnostics.length > 0
    ? `\n${formatDiagnosticGroups(result.diagnostics)}\n`
    : "";

  return `${status}

Bundle:
  root: ${terminalValue(root)}
  files: ${result.files.length}
  changed: ${changed.length}
${changedList}${diagnostics}`;
}
