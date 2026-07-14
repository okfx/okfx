import { resolve } from "node:path";

import { Command } from "commander";

import { packBundle, type PackResult } from "@okfx/core";

import { parseOutputFormat, terminalValue, writeOutput, type CliOutputFormat } from "../output.js";
import type { CliContext } from "../program.js";

export function createPackCommand(context: CliContext): Command {
  return new Command("pack")
    .description("create a portable OKF bundle artifact")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--out <path>", "archive output path")
    .option("--name <name>", "bundle name for the manifest")
    .option("--format <format>", "output format: pretty or json", parseOutputFormat, "pretty")
    .option("--json", "shortcut for --format json", false)
    .action(async (
      bundle: string,
      options: { out?: string; name?: string; format: CliOutputFormat; json: boolean }
    ) => {
      const result = await packBundle(resolve(bundle), {
        out: options.out,
        bundleName: options.name
      });
      const format = options.json ? "json" : options.format;
      await writeOutput(formatPack(result, format), undefined, context.io);
      context.setExitCode(0);
    });
}

function formatPack(result: PackResult, format: CliOutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify({
      out: result.out,
      metadataDir: result.metadataDir,
      manifest: result.manifest,
      checksums: result.checksums,
      provenance: result.provenance
    }, null, 2)}\n`;
  }

  return `OKF bundle packed

Archive:
  ${terminalValue(result.out)}

Metadata:
  ${terminalValue(result.metadataDir)}/manifest.json
  ${terminalValue(result.metadataDir)}/checksums.json
  ${terminalValue(result.metadataDir)}/provenance.json

Bundle:
  name: ${terminalValue(result.manifest.bundle_name)}
  concepts: ${result.manifest.concept_count}
  files: ${result.manifest.file_count}
  content hash: sha256:${result.manifest.content_hash}
`;
}
