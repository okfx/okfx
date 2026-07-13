import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { produceBigQueryOkf } from "@okfx/adapter-bigquery";
import { produceDataHubOkf } from "@okfx/adapter-datahub";
import { produceDbtOkf } from "@okfx/adapter-dbt";
import { produceMarkdownOkf } from "@okfx/adapter-markdown";
import { produceOpenApiOkf } from "@okfx/adapter-openapi";

import type { CliContext } from "../program.js";

type ImportAdapter = "markdown" | "openapi" | "dbt" | "datahub" | "bigquery";

interface ProducedFile {
  path: string;
  content: string;
}

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
        const resolvedFiles = resolveProducedFiles(out, files);
        if (!options.force) {
          const existing = (await Promise.all(resolvedFiles.map(async (file) => {
            try {
              await access(file.path);
              return file.relativePath;
            } catch {
              return undefined;
            }
          }))).filter((path): path is string => path !== undefined);
          if (existing.length > 0) {
            throw new Error(`Refusing to overwrite existing generated files: ${existing.join(", ")}. Use --force to overwrite.`);
          }
        }

        for (const file of resolvedFiles) {
          const path = file.path;
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.content, {
            encoding: "utf8",
            flag: options.force ? "w" : "wx"
          });
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

function resolveProducedFiles(root: string, files: ProducedFile[]): Array<ProducedFile & { path: string; relativePath: string }> {
  const seen = new Set<string>();

  return files.map((file) => {
    if (typeof file.path !== "string" || file.path.length === 0 || file.path.includes("\0") || isAbsolute(file.path)) {
      throw new Error(`Adapter produced an invalid relative path: ${JSON.stringify(file.path)}`);
    }

    const path = resolve(root, file.path);
    const relativePath = relative(root, path);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)) {
      throw new Error(`Adapter output path escapes the output root: ${JSON.stringify(file.path)}`);
    }
    if (seen.has(path)) {
      throw new Error(`Adapter produced duplicate output path: ${JSON.stringify(file.path)}`);
    }
    seen.add(path);
    return {
      ...file,
      path,
      relativePath
    };
  });
}

function parseAdapter(value: string): ImportAdapter {
  if (value === "markdown" || value === "openapi" || value === "dbt" || value === "datahub" || value === "bigquery") {
    return value;
  }

  throw new InvalidArgumentError(`unsupported adapter "${value}"`);
}

function produce(adapter: ImportAdapter, input: unknown): ProducedFile[] {
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
