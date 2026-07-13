import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { produceBigQueryOkf } from "@okfx/adapter-bigquery";
import { produceDataHubOkf } from "@okfx/adapter-datahub";
import { produceDbtOkf } from "@okfx/adapter-dbt";
import { produceMarkdownOkf } from "@okfx/adapter-markdown";
import { produceOpenApiOkf } from "@okfx/adapter-openapi";

import {
  ensureSafeGeneratedParent,
  inspectGeneratedPath,
  resolveGeneratedFiles,
  writeGeneratedFile,
  type GeneratedFile
} from "../generated-files.js";
import type { CliContext } from "../program.js";

type ImportAdapter = "markdown" | "openapi" | "dbt" | "datahub" | "bigquery";

export function createImportCommand(context: CliContext): Command {
  return new Command("import")
    .description("produce reviewable OKF draft files from local metadata")
    .argument("<adapter>", "adapter: markdown, openapi, dbt, datahub, or bigquery", parseAdapter)
    .requiredOption("--input <path>", "local JSON input file")
    .option("--out <path>", "output bundle root", ".")
    .option("--write", "write generated files to --out", false)
    .option("--dry-run", "print generated files without writing", false)
    .option("--force", "overwrite generated files that already exist", false)
    .action(async (adapter: ImportAdapter, options: { input: string; out: string; write: boolean; dryRun: boolean; force: boolean }) => {
      const input = JSON.parse(await readFile(resolve(options.input), "utf8")) as unknown;
      const files = produce(adapter, input);

      if (options.write && !options.dryRun) {
        const out = resolve(options.out);
        const resolvedFiles = resolveGeneratedFiles(out, files);
        const existingPaths = await Promise.all(resolvedFiles.map((file) => inspectGeneratedPath(out, file.relativePath)));
        if (!options.force) {
          const existing = resolvedFiles
            .filter((_, index) => existingPaths[index])
            .map((file) => file.relativePath);
          if (existing.length > 0) {
            throw new Error(`Refusing to overwrite existing generated files: ${existing.join(", ")}. Use --force to overwrite.`);
          }
        }

        for (const file of resolvedFiles) {
          await ensureSafeGeneratedParent(out, file.relativePath);
          await inspectGeneratedPath(out, file.relativePath);
          await writeGeneratedFile(file.path, file.content, options.force);
        }

        context.io.stdout.write(`Generated ${files.length} OKF files in ${out}\n`);
        for (const file of files) {
          context.io.stdout.write(`  ${file.path}\n`);
        }
        return;
      }

      context.io.stdout.write(`${JSON.stringify({ adapter, files }, null, 2)}\n`);
    });
}

function parseAdapter(value: string): ImportAdapter {
  if (value === "markdown" || value === "openapi" || value === "dbt" || value === "datahub" || value === "bigquery") {
    return value;
  }

  throw new InvalidArgumentError(`unsupported adapter "${value}"`);
}

function produce(adapter: ImportAdapter, input: unknown): GeneratedFile[] {
  switch (adapter) {
    case "markdown":
      return produceMarkdownOkf(input as Parameters<typeof produceMarkdownOkf>[0]);
    case "openapi":
      return produceOpenApiOkf(input as Parameters<typeof produceOpenApiOkf>[0]);
    case "dbt":
      return produceDbtOkf(input as Parameters<typeof produceDbtOkf>[0]);
    case "datahub":
      return produceDataHubOkf(input as Parameters<typeof produceDataHubOkf>[0]);
    case "bigquery":
      return produceBigQueryOkf(input as Parameters<typeof produceBigQueryOkf>[0]);
  }
}
