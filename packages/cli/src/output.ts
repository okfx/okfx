import { basename, dirname, resolve } from "node:path";

import { InvalidArgumentError } from "commander";

import { ensureSafeGeneratedParent, inspectGeneratedPath, writeGeneratedFile } from "./generated-files.js";
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
  const root = dirname(resolved);
  const relativePath = basename(resolved);
  await ensureSafeGeneratedParent(root, relativePath);
  await inspectGeneratedPath(root, relativePath);
  await writeGeneratedFile(resolved, text, true);
}

export function formatDiagnosticGroups(diagnostics: DiagnosticIR[]): string {
  const groups = new Map<string, DiagnosticIR[]>();
  for (const diagnostic of diagnostics) {
    const group = groups.get(diagnostic.severity);
    if (group) {
      group.push(diagnostic);
    } else {
      groups.set(diagnostic.severity, [diagnostic]);
    }
  }

  return [...groups.entries()]
    .map(([severity, entries]) => `${severity}s:
${entries.map(formatDiagnostic).join("\n")}`)
    .join("\n\n");
}

export function formatDiagnostic(diagnostic: DiagnosticIR): string {
  const location = diagnostic.location?.start;
  const path = diagnostic.path
    ? `${terminalValue(diagnostic.path)}${location ? `:${location.line}:${location.column}` : ""}`
    : "(bundle)";

  return `  ${terminalValue(diagnostic.code)}
    ${path}
    ${terminalValue(diagnostic.message)}`;
}

export function terminalValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (character) => {
    if (character === "\n") {
      return "\\n";
    }
    if (character === "\r") {
      return "\\r";
    }
    if (character === "\t") {
      return "\\t";
    }
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
