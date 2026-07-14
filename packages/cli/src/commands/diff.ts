import { resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { diffBundles, loadBundle, type BundleDiffIR } from "@okfx/core";

import { writeOutput } from "../output.js";
import type { CliContext } from "../program.js";

type DiffFormat = "pretty" | "json" | "markdown";

export function createDiffCommand(context: CliContext): Command {
  return new Command("diff")
    .description("compare two OKF bundles semantically")
    .argument("<before>", "before OKF bundle root")
    .argument("<after>", "after OKF bundle root")
    .option("--format <format>", "output format: pretty, json, or markdown", parseDiffFormat, "pretty")
    .option("--json", "shortcut for --format json", false)
    .option("--out <path>", "write output to a file")
    .action(async (
      before: string,
      after: string,
      options: { format: DiffFormat; json: boolean; out?: string }
    ) => {
      const beforeBundle = await loadBundle(resolve(before));
      const afterBundle = await loadBundle(resolve(after));
      const diff = diffBundles(beforeBundle, afterBundle);
      const format = options.json ? "json" : options.format;
      await writeOutput(formatDiff(diff, format), options.out, context.io);
      context.setExitCode(hasChanges(diff) ? 1 : 0);
    });
}

function parseDiffFormat(value: string): DiffFormat {
  if (value === "pretty" || value === "json" || value === "markdown") {
    return value;
  }

  throw new InvalidArgumentError(`unsupported diff format "${value}"`);
}

function formatDiff(diff: BundleDiffIR, format: DiffFormat): string {
  if (format === "json") {
    return `${JSON.stringify(diff, null, 2)}\n`;
  }

  if (format === "markdown") {
    return markdownDiff(diff);
  }

  return prettyDiff(diff);
}

function hasChanges(diff: BundleDiffIR): boolean {
  return diff.stats.addedCount + diff.stats.removedCount + diff.stats.renamedCount + diff.stats.changedCount > 0
    || diff.stats.readinessChanged;
}

function prettyDiff(diff: BundleDiffIR): string {
  if (!hasChanges(diff)) {
    return "Bundle diff\n\nNo semantic changes.\n";
  }

  return `Bundle diff

${section("Added concepts", diff.addedConcepts, "+")}
${section("Removed concepts", diff.removedConcepts, "-")}
${renameSection(diff)}
${changedSection(diff)}
${readinessSection(diff)}
`;
}

function markdownDiff(diff: BundleDiffIR): string {
  if (!hasChanges(diff)) {
    return "## OKF Diff\n\nNo semantic changes.\n";
  }

  return `## OKF Diff

${markdownList("Added concepts", diff.addedConcepts, "+")}
${markdownList("Removed concepts", diff.removedConcepts, "-")}
${markdownRenameList(diff)}
${markdownChangedList(diff)}
${markdownReadinessSection(diff)}
`;
}

function section(title: string, values: string[], marker: string): string {
  if (values.length === 0) {
    return `${title}:\n  none\n`;
  }

  return `${title}:\n${values.map((value) => `  ${marker} ${value}`).join("\n")}\n`;
}

function renameSection(diff: BundleDiffIR): string {
  if (diff.renamedConcepts.length === 0) {
    return "Renamed concepts:\n  none\n";
  }

  return `Renamed concepts:\n${diff.renamedConcepts.map((entry) => `  ~ ${entry.from} -> ${entry.to}`).join("\n")}\n`;
}

function changedSection(diff: BundleDiffIR): string {
  if (diff.changedConcepts.length === 0) {
    return "Changed concepts:\n  none\n";
  }

  return `Changed concepts:\n${diff.changedConcepts.map((concept) => `  ~ ${concept.id}\n${concept.changes.map((change) => `    ${change}`).join("\n")}`).join("\n")}\n`;
}

function readinessSection(diff: BundleDiffIR): string {
  return `Agent readiness:\n  ${diff.agentReadiness.beforeScore} -> ${diff.agentReadiness.afterScore} (${formatDelta(diff.agentReadiness.delta)})\n`;
}

function markdownList(title: string, values: string[], marker: string): string {
  if (values.length === 0) {
    return `### ${title}\n\nNone.\n`;
  }

  return `### ${title}\n\n${values.map((value) => `- ${markdownCode(`${marker} ${value}`)}`).join("\n")}\n`;
}

function markdownRenameList(diff: BundleDiffIR): string {
  if (diff.renamedConcepts.length === 0) {
    return "### Renamed concepts\n\nNone.\n";
  }

  return `### Renamed concepts\n\n${diff.renamedConcepts.map((entry) => `- ${markdownCode(entry.from)} -> ${markdownCode(entry.to)}`).join("\n")}\n`;
}

function markdownChangedList(diff: BundleDiffIR): string {
  if (diff.changedConcepts.length === 0) {
    return "### Changed concepts\n\nNone.\n";
  }

  return `### Changed concepts\n\n${diff.changedConcepts.map((concept) => `- ${markdownCode(concept.id)}\n${concept.changes.map((change) => `  - ${markdownCode(change)}`).join("\n")}`).join("\n")}\n`;
}

function markdownReadinessSection(diff: BundleDiffIR): string {
  return `### Agent readiness\n\n${diff.agentReadiness.beforeScore} -> ${diff.agentReadiness.afterScore} (${formatDelta(diff.agentReadiness.delta)})\n`;
}

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function markdownCode(value: string): string {
  const visibleValue = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const longestFence = Math.max(0, ...[...visibleValue.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  const padding = /^[ `]|[ `]$/.test(visibleValue) ? " " : "";
  return `${fence}${padding}${visibleValue}${padding}${fence}`;
}
