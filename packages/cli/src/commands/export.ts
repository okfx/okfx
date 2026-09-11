import { resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { exportStaticSite } from "@okfxjs/adapter-static-site";
import { buildGraph, loadBundle } from "@okfxjs/core";

import {
  ensureSafeGeneratedParent,
  inspectGeneratedPath,
  resolveGeneratedFiles,
  writeGeneratedFile
} from "../generated-files.js";
import { terminalValue } from "../output.js";
import type { CliContext } from "../program.js";

type ExportTarget = "static-site";

export function createExportCommand(context: CliContext): Command {
  return new Command("export")
    .description("export an OKF bundle to a consumer surface")
    .argument("<target>", "target: static-site", parseTarget)
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--out <path>", "output directory", "site")
    .option("--write", "write generated files to --out", false)
    .option("--dry-run", "print generated files without writing", false)
    .option("--force", "overwrite generated files that already exist", false)
    .action(async (target: ExportTarget, bundle: string, options: { out: string; write: boolean; dryRun: boolean; force: boolean }) => {
      const root = resolve(bundle);
      const loaded = await loadBundle(root);
      const files = exportTarget(target, loaded);

      if (options.write && !options.dryRun) {
        const out = resolve(options.out);
        const resolvedFiles = resolveGeneratedFiles(out, files);
        const existingPaths = await Promise.all(
          resolvedFiles.map((file) => inspectGeneratedPath(out, file.relativePath))
        );
        if (!options.force) {
          const existing = resolvedFiles
            .filter((_, index) => existingPaths[index])
            .map((file) => file.relativePath);
          if (existing.length > 0) {
            throw new Error(`Refusing to overwrite existing exported files: ${existing.join(", ")}. Use --force to overwrite.`);
          }
        }

        for (const file of resolvedFiles) {
          await ensureSafeGeneratedParent(out, file.relativePath);
          await inspectGeneratedPath(out, file.relativePath);
          await writeGeneratedFile(file.path, file.content, options.force);
        }
        context.io.stdout.write(`Exported ${files.length} ${terminalValue(target)} files to ${terminalValue(out)}\n`);
        for (const file of files) {
          context.io.stdout.write(`  ${terminalValue(file.path)}\n`);
        }
        return;
      }

      context.io.stdout.write(`${JSON.stringify({ target, files }, null, 2)}\n`);
    });
}

function parseTarget(value: string): ExportTarget {
  if (value === "static-site") {
    return value;
  }

  throw new InvalidArgumentError(`unsupported export target "${value}"`);
}

function exportTarget(target: ExportTarget, bundle: Awaited<ReturnType<typeof loadBundle>>) {
  switch (target) {
    case "static-site":
      return exportStaticSite(bundle, {
        graph: buildGraph(bundle),
        title: "OKF Bundle"
      });
  }
}
