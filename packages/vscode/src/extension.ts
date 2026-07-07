import { relative, sep } from "node:path";

import * as vscode from "vscode";

import {
  buildGraph,
  doctorBundle,
  formatMarkdownFile,
  graphToHtml,
  lintBundle,
  loadBundle,
  resolveMarkdownTarget,
  validateBundle,
  type BundleIR,
  type DiagnosticIR,
  type DiagnosticSeverity
} from "@okfx/core";

let diagnostics: vscode.DiagnosticCollection | undefined;
let statusBar: vscode.StatusBarItem | undefined;

type DiagnosticMode = "validate" | "lint" | "doctor";

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection("okfx");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "okfx.doctorPanel";
  statusBar.text = "OKF";
  statusBar.tooltip = "Run OKF doctor";
  statusBar.show();

  context.subscriptions.push(diagnostics, statusBar);
  context.subscriptions.push(
    vscode.commands.registerCommand("okfx.validate", () => runWithErrors("validate", () => runDiagnostics("validate"))),
    vscode.commands.registerCommand("okfx.lint", () => runWithErrors("lint", () => runDiagnostics("lint"))),
    vscode.commands.registerCommand("okfx.doctor", () => runWithErrors("doctor", () => runDiagnostics("doctor"))),
    vscode.commands.registerCommand("okfx.format", () => runWithErrors("format", () => runFormat())),
    vscode.commands.registerCommand("okfx.graphPreview", () => runWithErrors("graph preview", () => showGraphPreview(context))),
    vscode.commands.registerCommand("okfx.doctorPanel", () => runWithErrors("doctor panel", () => showDoctorPanel(context))),
    vscode.workspace.onDidSaveTextDocument((document) => onDidSave(document)),
    vscode.languages.registerDocumentFormattingEditProvider({ language: "markdown" }, {
      provideDocumentFormattingEdits: (document) => formatDocument(document)
    }),
    vscode.languages.registerCompletionItemProvider({ language: "markdown" }, {
      provideCompletionItems: (document, position) => provideCompletions(document, position)
    }, "[", "/", "-"),
    vscode.languages.registerDefinitionProvider({ language: "markdown" }, {
      provideDefinition: (document, position) => provideDefinition(document, position)
    })
  );
}

export function deactivate(): void {
  diagnostics?.dispose();
  statusBar?.dispose();
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

async function onDidSave(document: vscode.TextDocument): Promise<void> {
  if (document.languageId !== "markdown") {
    return;
  }
  if (config().get<boolean>("diagnostics.onSave", true)) {
    await runWithErrors("diagnostics", () => runDiagnostics("lint", true));
  }
  if (config().get<boolean>("format.onSave", false)) {
    await vscode.commands.executeCommand("editor.action.formatDocument");
  }
}

async function runDiagnostics(mode: DiagnosticMode, silent = false): Promise<void> {
  const root = workspaceRoot();
  if (!root || !diagnostics) {
    return;
  }

  status("OKF: checking...");
  const bundle = await loadBundle(root);
  const result = mode === "validate"
    ? validateBundle(bundle)
    : mode === "lint"
      ? lintBundle(bundle)
      : doctorBundle(bundle);
  diagnostics.clear();
  publishDiagnostics(root, result.diagnostics);
  status(`OKF: ${result.diagnostics.length} diagnostics`);

  if (!silent) {
    await vscode.window.showInformationMessage(`OKF ${mode} completed: ${result.diagnostics.length} diagnostics.`);
  }
}

async function runFormat(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === "markdown") {
    await vscode.commands.executeCommand("editor.action.formatDocument");
    return;
  }

  await vscode.window.showInformationMessage("Open a Markdown document to format it with OKF.");
}

async function showGraphPreview(context: vscode.ExtensionContext): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    return;
  }

  const bundle = await loadBundle(root);
  const graph = buildGraph(bundle);
  const panel = vscode.window.createWebviewPanel(
    "okfxGraph",
    "OKF Graph",
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  panel.webview.html = graphToHtml(graph);
  context.subscriptions.push(panel);
}

async function showDoctorPanel(context: vscode.ExtensionContext): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    return;
  }

  const bundle = await loadBundle(root);
  const result = doctorBundle(bundle);
  publishDiagnostics(root, result.diagnostics);
  const panel = vscode.window.createWebviewPanel(
    "okfxDoctor",
    "OKF Doctor",
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  panel.webview.html = doctorHtml(bundle, result.score, result.diagnostics);
  context.subscriptions.push(panel);
}

function formatDocument(document: vscode.TextDocument): vscode.TextEdit[] {
  if (!config().get<boolean>("format.enableFormatter", true)) {
    return [];
  }

  const root = workspaceRoot();
  const path = root ? relativePosix(root, document.uri.fsPath) : document.fileName;
  const result = formatMarkdownFile(path, document.getText());
  if (!result.changed || result.diagnostics.length > 0) {
    return [];
  }

  const end = document.lineAt(document.lineCount - 1).range.end;
  return [vscode.TextEdit.replace(new vscode.Range(new vscode.Position(0, 0), end), result.formatted)];
}

async function provideCompletions(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.CompletionItem[]> {
  const line = document.lineAt(position).text.slice(0, position.character);
  if (isFrontmatterContext(document, position)) {
    return ["type", "title", "description", "resource", "tags", "timestamp", "owner", "status"]
      .map((key) => {
        const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Field);
        item.insertText = `${key}: `;
        return item;
      });
  }

  if (!line.includes("](") && !line.endsWith("[") && !line.includes("[[")) {
    return [];
  }

  const root = workspaceRoot();
  if (!root) {
    return [];
  }

  const bundle = await loadBundle(root);
  return bundle.concepts.map((concept) => {
    const item = new vscode.CompletionItem(concept.path, vscode.CompletionItemKind.Reference);
    item.detail = concept.title ?? concept.id;
    item.insertText = concept.path;
    return item;
  });
}

async function provideDefinition(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Definition | undefined> {
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }

  const targetRaw = markdownTargetAt(document.lineAt(position).text, position.character);
  if (!targetRaw) {
    return undefined;
  }

  const sourcePath = relativePosix(root, document.uri.fsPath);
  const targetId = resolveMarkdownTarget(sourcePath, targetRaw);
  if (!targetId) {
    return undefined;
  }

  const bundle = await loadBundle(root);
  const concept = bundle.concepts.find((item) => item.id === targetId);
  if (!concept) {
    return undefined;
  }

  return new vscode.Location(vscode.Uri.file(`${root}/${concept.path}`), new vscode.Position(0, 0));
}

function publishDiagnostics(root: string, entries: DiagnosticIR[]): void {
  if (!diagnostics) {
    return;
  }

  const byPath = new Map<string, DiagnosticIR[]>();
  for (const diagnostic of entries) {
    if (!diagnostic.path) {
      continue;
    }
    byPath.set(diagnostic.path, [...(byPath.get(diagnostic.path) ?? []), diagnostic]);
  }

  diagnostics.clear();
  for (const [path, pathDiagnostics] of byPath) {
    diagnostics.set(vscode.Uri.file(`${root}/${path}`), pathDiagnostics.map(toVsCodeDiagnostic));
  }
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toVsCodeDiagnostic(diagnostic: DiagnosticIR): vscode.Diagnostic {
  const start = diagnostic.location?.start;
  const range = start
    ? new vscode.Range(Math.max(0, start.line - 1), Math.max(0, start.column - 1), Math.max(0, start.line - 1), Number.MAX_SAFE_INTEGER)
    : new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);
  const converted = new vscode.Diagnostic(range, `${diagnostic.code}: ${diagnostic.message}`, severityFor(diagnostic.severity));
  converted.source = "okfx";
  converted.code = diagnostic.code;
  return converted;
}

function isFrontmatterContext(document: vscode.TextDocument, position: vscode.Position): boolean {
  if (position.line > 40 || document.lineAt(0).text.trim() !== "---") {
    return false;
  }

  for (let index = 1; index < position.line; index += 1) {
    if (document.lineAt(index).text.trim() === "---") {
      return false;
    }
  }
  return true;
}

function markdownTargetAt(line: string, character: number): string | undefined {
  const uptoCursor = line.slice(0, character);
  const linkStart = uptoCursor.lastIndexOf("](");
  if (linkStart === -1) {
    return undefined;
  }

  const targetStart = linkStart + 2;
  const targetEnd = line.indexOf(")", targetStart);
  if (targetEnd !== -1 && character > targetEnd) {
    return undefined;
  }

  return line.slice(targetStart, targetEnd === -1 ? undefined : targetEnd).trim() || undefined;
}

function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function doctorHtml(bundle: BundleIR, score: number, entries: DiagnosticIR[]): string {
  const diagnosticsHtml = entries.slice(0, 50).map((diagnostic) => `
    <li><strong>${escapeHtml(diagnostic.code)}</strong> ${escapeHtml(diagnostic.path ?? "(bundle)")}: ${escapeHtml(diagnostic.message)}</li>
  `).join("");
  return `<!doctype html>
<html>
  <body>
    <h1>OKF Doctor</h1>
    <p>Score: <strong>${score}/100</strong></p>
    <p>Concepts: ${bundle.stats.conceptCount} | Links: ${bundle.stats.linkCount} | Broken links: ${bundle.stats.brokenLinkCount}</p>
    <h2>Diagnostics</h2>
    <ul>${diagnosticsHtml || "<li>none</li>"}</ul>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function status(text: string): void {
  if (statusBar) {
    statusBar.text = text;
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("okfx");
}

async function runWithErrors(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    status("OKF: error");
    await vscode.window.showErrorMessage(`OKF ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
