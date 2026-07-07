import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { exportStaticSite } from "@okfx/adapter-static-site";
import { buildGraph, loadBundle } from "@okfx/core";

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
    .action(async (target: ExportTarget, bundle: string, options: { out: string; write: boolean; dryRun: boolean }) => {
      const root = resolve(bundle);
      const loaded = await loadBundle(root);
      const files = exportTarget(target, loaded);

      if (options.write && !options.dryRun) {
        const out = resolve(options.out);
        for (const file of files) {
          const path = join(out, file.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.content, "utf8");
        }
        context.io.stdout.write(`Exported ${files.length} ${target} files to ${out}\n`);
        for (const file of files) {
          context.io.stdout.write(`  ${file.path}\n`);
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
