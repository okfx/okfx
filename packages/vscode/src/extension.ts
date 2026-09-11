import { basename, join, relative, sep } from "node:path";

import * as vscode from "vscode";

import {
  backlinksForConcept,
  buildGraph,
  conceptIdFromPath,
  doctorBundle,
  formatMarkdownFile,
  graphToHtml,
  lintBundleWithPlugins,
  loadBundle,
  loadConfig,
  loadConfiguredPlugins,
  relativeMarkdownTarget,
  validateBundle,
  type BundleIR,
  type DiagnosticIR,
  type DiagnosticSeverity
} from "@okfxjs/core";

import { markdownTargetAtDocument, resolveDefinitionTarget } from "./markdown-target.js";
import { LatestRunTracker } from "./latest-run.js";

let diagnostics: vscode.DiagnosticCollection | undefined;
let statusBar: vscode.StatusBarItem | undefined;
const diagnosticPathsByRoot = new Map<string, Set<string>>();
const diagnosticRuns = new LatestRunTracker();

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
    vscode.commands.registerCommand("okfx.backlinksPanel", () => runWithErrors("backlinks panel", () => showBacklinksPanel(context))),
    vscode.workspace.onWillSaveTextDocument((event) => onWillSave(event)),
    vscode.workspace.onDidSaveTextDocument((document) => onDidSave(document)),
    vscode.languages.registerDocumentFormattingEditProvider({ language: "markdown" }, {
      provideDocumentFormattingEdits: (document) => formatDocument(document)
    }),
    vscode.languages.registerCompletionItemProvider({ language: "markdown" }, {
      provideCompletionItems: (document, position) => provideCompletions(document, position)
    }, "[", "/", "-"),
    vscode.languages.registerDefinitionProvider({ language: "markdown" }, {
      provideDefinition: (document, position) => provideDefinition(document, position)
    }),
    vscode.languages.registerCodeActionsProvider({ language: "markdown" }, {
      provideCodeActions: (document, range, codeActionContext) => provideQuickFixes(document, range, codeActionContext)
    }, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
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
  if (config(document.uri).get<boolean>("diagnostics.onSave", true)) {
    await runWithErrors("diagnostics", () => runDiagnostics("lint", true, document.uri));
  }
}

function onWillSave(event: vscode.TextDocumentWillSaveEvent): void {
  const { document } = event;
  if (
    document.languageId === "markdown"
    && config(document.uri).get<boolean>("format.onSave", false)
  ) {
    event.waitUntil(formatDocument(document));
  }
}

async function runDiagnostics(
  mode: DiagnosticMode,
  silent = false,
  resource?: vscode.Uri
): Promise<void> {
  const root = workspaceRoot(resource);
  if (!root || !diagnostics) {
    return;
  }

  const isCurrentRun = diagnosticRuns.begin(root);
  status("OKF: checking...");
  try {
    const okfxConfig = await loadConfig(root);
    const bundle = await loadBundle(root, { config: okfxConfig, loadConfigFile: false });
    let result: { diagnostics: DiagnosticIR[] };
    if (mode === "validate") {
      result = validateBundle(bundle);
    } else if (mode === "lint") {
      const pluginLoad = await loadConfiguredPlugins(root, okfxConfig);
      result = await lintBundleWithPlugins(bundle, {
        config: okfxConfig,
        plugins: pluginLoad.plugins,
        pluginDiagnostics: pluginLoad.diagnostics
      });
    } else {
      result = doctorBundle(bundle, { config: okfxConfig });
    }
    if (!isCurrentRun()) {
      return;
    }
    publishDiagnostics(root, result.diagnostics);
    status(`OKF: ${result.diagnostics.length} diagnostics`);

    if (!silent) {
      await vscode.window.showInformationMessage(`OKF ${mode} completed: ${result.diagnostics.length} diagnostics.`);
    }
  } catch (error) {
    if (isCurrentRun()) {
      throw error;
    }
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

  const okfxConfig = await loadConfig(root);
  const bundle = await loadBundle(root, { config: okfxConfig, loadConfigFile: false });
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

  const okfxConfig = await loadConfig(root);
  const bundle = await loadBundle(root, { config: okfxConfig, loadConfigFile: false });
  const result = doctorBundle(bundle, { config: okfxConfig });
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

async function showBacklinksPanel(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const root = editor ? workspaceRoot(editor.document.uri) : undefined;
  if (!root || !editor || editor.document.languageId !== "markdown") {
    await vscode.window.showInformationMessage("Open an OKF Markdown concept to inspect backlinks.");
    return;
  }

  const sourcePath = relativePosix(root, editor.document.uri.fsPath);
  const conceptId = conceptIdFromPath(sourcePath);
  const bundle = await loadBundle(root);
  const graph = buildGraph(bundle);
  const backlinks = backlinksForConcept(graph, conceptId);
  const panel = vscode.window.createWebviewPanel(
    "okfxBacklinks",
    "OKF Backlinks",
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  panel.webview.html = backlinksHtml(conceptId, backlinks, bundle);
  context.subscriptions.push(panel);
}

async function formatDocument(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
  if (!config(document.uri).get<boolean>("format.enableFormatter", true)) {
    return [];
  }

  const root = workspaceRoot(document.uri);
  const path = root ? relativePosix(root, document.uri.fsPath) : document.fileName;
  const okfxConfig = root ? await loadConfig(root) : undefined;
  const result = formatMarkdownFile(path, document.getText(), okfxConfig);
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

  const root = workspaceRoot(document.uri);
  if (!root) {
    return [];
  }

  const bundle = await loadBundle(root);
  const sourcePath = relativePosix(root, document.uri.fsPath);
  return bundle.concepts.map((concept) => {
    const item = new vscode.CompletionItem(concept.path, vscode.CompletionItemKind.Reference);
    item.detail = concept.title ?? concept.id;
    item.insertText = relativeMarkdownTarget(sourcePath, concept.path);
    return item;
  });
}

async function provideDefinition(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Definition | undefined> {
  const root = workspaceRoot(document.uri);
  if (!root) {
    return undefined;
  }

  const targetRaw = markdownTargetAtDocument(document.getText(), position.line, position.character);
  if (!targetRaw) {
    return undefined;
  }

  const sourcePath = relativePosix(root, document.uri.fsPath);
  const targetId = resolveDefinitionTarget(sourcePath, targetRaw);
  if (!targetId) {
    return undefined;
  }

  const bundle = await loadBundle(root);
  const concept = bundle.concepts.find((item) => item.id === targetId);
  if (!concept) {
    return undefined;
  }

  return new vscode.Location(vscode.Uri.file(join(root, concept.path)), new vscode.Position(0, 0));
}

function provideQuickFixes(
  document: vscode.TextDocument,
  _range: vscode.Range,
  context: vscode.CodeActionContext
): vscode.CodeAction[] {
  return context.diagnostics
    .filter((diagnostic) => diagnostic.source === "okfx")
    .flatMap((diagnostic) => quickFixForDiagnostic(document, diagnostic));
}

function quickFixForDiagnostic(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction[] {
  const code = typeof diagnostic.code === "string" ? diagnostic.code : undefined;
  const fix = fieldFixForCode(document, code);
  if (!fix) {
    return [];
  }

  const action = new vscode.CodeAction(`OKF: Add ${fix.field}`, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, fix.position, fix.text);
  action.edit = edit;
  return [action];
}

function fieldFixForCode(document: vscode.TextDocument, code: string | undefined): { field: string; position: vscode.Position; text: string } | undefined {
  const field = code === "spec/missing-type"
    ? "type"
    : code === "hygiene/missing-title"
      ? "title"
      : undefined;
  if (!field) {
    return undefined;
  }

  const value = field === "type"
    ? "Note"
    : titleFromDocument(document);
  const yamlValue = field === "title" ? JSON.stringify(value) : value;
  const insert = frontmatterInsertionPoint(document);
  if (insert) {
    return {
      field,
      position: insert,
      text: `${field}: ${yamlValue}\n`
    };
  }

  return {
    field,
    position: new vscode.Position(0, 0),
    text: `---\n${field}: ${yamlValue}\n---\n\n`
  };
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
    const pathDiagnostics = byPath.get(diagnostic.path);
    if (pathDiagnostics) {
      pathDiagnostics.push(diagnostic);
    } else {
      byPath.set(diagnostic.path, [diagnostic]);
    }
  }

  for (const path of diagnosticPathsByRoot.get(root) ?? []) {
    diagnostics.delete(vscode.Uri.file(path));
  }

  const currentPaths = new Set<string>();
  for (const [path, pathDiagnostics] of byPath) {
    const absolutePath = join(root, path);
    currentPaths.add(absolutePath);
    diagnostics.set(vscode.Uri.file(absolutePath), pathDiagnostics.map(toVsCodeDiagnostic));
  }
  diagnosticPathsByRoot.set(root, currentPaths);
}

function workspaceRoot(resource?: vscode.Uri): string | undefined {
  if (resource) {
    return vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath;
  }

  const activeResource = vscode.window.activeTextEditor?.document.uri;
  if (activeResource) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeResource);
    if (activeFolder) {
      return activeFolder.uri.fsPath;
    }
  }
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

function frontmatterInsertionPoint(document: vscode.TextDocument): vscode.Position | undefined {
  if (document.lineCount === 0 || document.lineAt(0).text.trim() !== "---") {
    return undefined;
  }

  return new vscode.Position(1, 0);
}

function titleFromDocument(document: vscode.TextDocument): string {
  return basename(document.fileName, ".md")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
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

function backlinksHtml(conceptId: string, backlinks: string[], bundle: BundleIR): string {
  const conceptsById = new Map(bundle.concepts.map((concept) => [concept.id, concept]));
  const backlinksHtml = backlinks.map((id) => {
    const concept = conceptsById.get(id);
    return `<li><code>${escapeHtml(id)}</code>${concept?.title ? ` - ${escapeHtml(concept.title)}` : ""}</li>`;
  }).join("");

  return `<!doctype html>
<html>
  <body>
    <h1>OKF Backlinks</h1>
    <p><code>${escapeHtml(conceptId)}</code></p>
    <ul>${backlinksHtml || "<li>none</li>"}</ul>
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

function config(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("okfx", resource);
}

async function runWithErrors(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    status("OKF: error");
    await vscode.window.showErrorMessage(`OKF ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
