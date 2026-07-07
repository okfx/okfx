import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { InvalidArgumentError } from "commander";

import type { CliIO } from "./program.js";
import type { DiagnosticIR } from "@okfx/core";

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

export function formatDiagnosticGroups(diagnostics: DiagnosticIR[]): string {
  const groups = new Map<string, DiagnosticIR[]>();
  for (const diagnostic of diagnostics) {
    groups.set(diagnostic.severity, [...(groups.get(diagnostic.severity) ?? []), diagnostic]);
  }

  return [...groups.entries()]
    .map(([severity, entries]) => `${severity}s:
${entries.map(formatDiagnostic).join("\n")}`)
    .join("\n\n");
}

export function formatDiagnostic(diagnostic: DiagnosticIR): string {
  const location = diagnostic.location?.start;
  const path = diagnostic.path
    ? `${diagnostic.path}${location ? `:${location.line}:${location.column}` : ""}`
    : "(bundle)";

  return `  ${diagnostic.code}
    ${path}
    ${diagnostic.message}`;
}
