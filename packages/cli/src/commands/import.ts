import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
        const existingPaths = await Promise.all(resolvedFiles.map((file) => inspectOutputPath(out, file.relativePath)));
        if (!options.force) {
          const existing = resolvedFiles
            .filter((_, index) => existingPaths[index])
            .map((file) => file.relativePath);
          if (existing.length > 0) {
            throw new Error(`Refusing to overwrite existing generated files: ${existing.join(", ")}. Use --force to overwrite.`);
          }
        }

        for (const file of resolvedFiles) {
          await ensureSafeOutputParent(out, file.relativePath);
          await inspectOutputPath(out, file.relativePath);
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

async function inspectOutputPath(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split(sep);
  let current = root;

  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to write through symbolic link in output path: ${relativePath}`);
      }
      if (index < segments.length - 1 && !entry.isDirectory()) {
        throw new Error(`Refusing to write through non-directory output path: ${relativePath}`);
      }
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  return true;
}

async function ensureSafeOutputParent(root: string, relativePath: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const parent = dirname(relativePath);
  if (parent === ".") {
    return;
  }

  let current = root;
  for (const segment of parent.split(sep)) {
    current = resolve(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to write through symbolic link in output path: ${relativePath}`);
      }
      if (!entry.isDirectory()) {
        throw new Error(`Refusing to write through non-directory output path: ${relativePath}`);
      }
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
      await mkdir(current);
    }
  }
}

async function writeGeneratedFile(path: string, content: string, force: boolean): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const flags = constants.O_WRONLY
    | constants.O_CREAT
    | noFollow
    | (force ? constants.O_TRUNC : constants.O_EXCL);
  const handle = await open(path, flags, 0o666);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
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
