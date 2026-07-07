import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { InvalidArgumentError } from "commander";

import type { CliIO } from "./program.js";

export type CliOutputFormat = "pretty" | "json";

export function parseOutputFormat(value: string): CliOutputFormat {
  if (value === "pretty" || value === "json") {
    return value;
  }

  throw new InvalidArgumentError(`unsupported output format "${value}"`);
}

export async function writeOutput(text: string, outPath: string | undefined, io: CliIO): Promise<void> {
  if (!outPath) {
    io.stdout.write(text);
    return;
  }

  const resolved = resolve(outPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, text, "utf8");
}
