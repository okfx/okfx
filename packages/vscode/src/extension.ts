import * as vscode from "vscode";

import {
  doctorBundle,
  formatBundle,
  lintBundle,
  loadBundle,
  validateBundle,
  type DiagnosticIR,
  type DiagnosticSeverity
} from "@okfx/core";

let diagnostics: vscode.DiagnosticCollection | undefined;

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection("okfx");
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(
    vscode.commands.registerCommand("okfx.validate", () => runDiagnostics("validate")),
    vscode.commands.registerCommand("okfx.lint", () => runDiagnostics("lint")),
    vscode.commands.registerCommand("okfx.doctor", () => runDiagnostics("doctor")),
    vscode.commands.registerCommand("okfx.format", () => runFormat())
  );
}

export function deactivate(): void {
  diagnostics?.dispose();
}

export function severityFor(severity: DiagnosticSeverity): vscode.DiagnosticSeverity {
  switch (severity) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "advice":
      return vscode.DiagnosticSeverity.Hint;
    case "info":
      return vscode.DiagnosticSeverity.Information;
  }
}

async function runDiagnostics(mode: "validate" | "lint" | "doctor"): Promise<void> {
  const root = workspaceRoot();
  if (!root || !diagnostics) {
    return;
  }

  const bundle = await loadBundle(root);
  const result = mode === "validate"
    ? validateBundle(bundle)
    : mode === "lint"
      ? lintBundle(bundle)
      : doctorBundle(bundle);
  diagnostics.clear();

  const byPath = new Map<string, DiagnosticIR[]>();
  for (const diagnostic of result.diagnostics) {
    if (!diagnostic.path) {
      continue;
    }
    byPath.set(diagnostic.path, [...(byPath.get(diagnostic.path) ?? []), diagnostic]);
  }

  for (const [path, entries] of byPath) {
    diagnostics.set(vscode.Uri.file(`${root}/${path}`), entries.map(toVsCodeDiagnostic));
  }

  await vscode.window.showInformationMessage(`OKF ${mode} completed: ${result.diagnostics.length} diagnostics.`);
}

async function runFormat(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    return;
  }

  const result = await formatBundle(root);
  await vscode.window.showInformationMessage(`OKF format completed: ${result.files.filter((file) => file.changed).length} files changed.`);
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toVsCodeDiagnostic(diagnostic: DiagnosticIR): vscode.Diagnostic {
  const start = diagnostic.location?.start;
  const range = start
    ? new vscode.Range(Math.max(0, start.line - 1), Math.max(0, start.column - 1), Math.max(0, start.line - 1), Number.MAX_SAFE_INTEGER)
    : new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);
  return new vscode.Diagnostic(range, `${diagnostic.code}: ${diagnostic.message}`, severityFor(diagnostic.severity));
}
