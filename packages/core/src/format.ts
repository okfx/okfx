import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument, type Pair, type YAMLMap } from "yaml";

import { loadConfig, resolveConfig, type OkfxConfig, type ResolvedOkfxConfig } from "./config.js";
import { discoverMarkdownFiles } from "./bundle.js";
import { resolveBundleRoot } from "./paths.js";
import type { DiagnosticIR } from "./types.js";

export interface FormatFileResult {
  path: string;
  changed: boolean;
  diagnostics: DiagnosticIR[];
}

export interface FormatBundleOptions {
  config?: OkfxConfig | ResolvedOkfxConfig;
  loadConfigFile?: boolean;
  check?: boolean;
}

export interface FormatBundleResult {
  ok: boolean;
  checked: boolean;
  changed: boolean;
  files: FormatFileResult[];
  diagnostics: DiagnosticIR[];
}

export function formatMarkdownFile(
  path: string,
  content: string,
  config: OkfxConfig | ResolvedOkfxConfig = {}
): { formatted: string; changed: boolean; diagnostics: DiagnosticIR[] } {
  const resolved = resolveConfig(config);
  const split = splitFrontmatter(content);
  const diagnostics: DiagnosticIR[] = [];
  const body = normalizeBody(split?.body ?? content);

  if (!split) {
    const formatted = body;
    return {
      formatted,
      changed: formatted !== content,
      diagnostics
    };
  }

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(split.raw, { prettyErrors: false });
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
  } catch (error) {
    diagnostics.push({
      code: "spec/invalid-frontmatter",
      severity: "error",
      message: error instanceof Error ? error.message : "Could not parse YAML frontmatter.",
      path
    });
    return {
      formatted: content,
      changed: false,
      diagnostics
    };
  }

  if (!isMap(document.contents)) {
    diagnostics.push({
      code: "spec/invalid-frontmatter",
      severity: "error",
      message: "Frontmatter must be a YAML mapping.",
      path
    });
    return {
      formatted: content,
      changed: false,
      diagnostics
    };
  }

  orderFrontmatter(document.contents, resolved.frontmatter.keyOrder);
  const formattedFrontmatter = document.toString({ lineWidth: 0 }).trimEnd();
  const formatted = `---\n${formattedFrontmatter}\n---\n\n${body}`;

  return {
    formatted,
    changed: formatted !== content,
    diagnostics
  };
}

export async function formatBundle(rootInput: string, options: FormatBundleOptions = {}): Promise<FormatBundleResult> {
  const root = resolveBundleRoot(rootInput);
  const config = options.loadConfigFile === false
    ? resolveConfig(options.config)
    : resolveConfig(options.config ?? await loadConfig(root));
  const files = await discoverMarkdownFiles(root, config);
  const results: FormatFileResult[] = [];
  const diagnostics: DiagnosticIR[] = [];

  for (const path of files) {
    const absolutePath = join(root, path);
    const content = await readFile(absolutePath, "utf8");
    const formatted = formatMarkdownFile(path, content, config);
    diagnostics.push(...formatted.diagnostics);
    results.push({
      path,
      changed: formatted.changed,
      diagnostics: formatted.diagnostics
    });

    if (formatted.changed && !options.check) {
      await writeFile(absolutePath, formatted.formatted, "utf8");
    }
  }

  const changed = results.some((result) => result.changed);

  return {
    ok: diagnostics.length === 0 && (!options.check || !changed),
    checked: options.check ?? false,
    changed,
    files: results,
    diagnostics
  };
}

function orderFrontmatter(frontmatter: YAMLMap, keyOrder: string[]): void {
  const entries = frontmatter.items.map((pair, index) => {
    const references = collectYamlReferences(pair);
    return {
      pair,
      index,
      key: scalarString(pair.key),
      ...references
    };
  });
  const anchorOwners = new Map<string, number>();
  for (const entry of entries) {
    for (const anchor of entry.anchors) {
      anchorOwners.set(anchor, entry.index);
    }
  }

  const remaining = new Set(entries.map((entry) => entry.index));
  const ordered: Pair[] = [];
  while (remaining.size > 0) {
    const candidates = entries.filter((entry) => remaining.has(entry.index) && [...entry.aliases].every((alias) => {
      const owner = anchorOwners.get(alias);
      return owner === undefined || owner === entry.index || !remaining.has(owner);
    }));
    const next = (candidates.length > 0 ? candidates : entries.filter((entry) => remaining.has(entry.index)))
      .sort((a, b) => compareFrontmatterEntries(a, b, keyOrder))[0];
    ordered.push(next.pair);
    remaining.delete(next.index);
  }
  frontmatter.items = ordered;

  const timestamp = frontmatter.items.find((pair) => scalarString(pair.key) === "timestamp");
  if (timestamp && isScalar(timestamp.value) && typeof timestamp.value.value === "string") {
    timestamp.value.value = normalizeTimestamp(timestamp.value.value);
  }
}

function compareFrontmatterEntries(
  a: { key?: string; index: number },
  b: { key?: string; index: number },
  keyOrder: string[]
): number {
  if (a.key === undefined || b.key === undefined) {
    return a.key === undefined ? (b.key === undefined ? a.index - b.index : 1) : -1;
  }
  return keyRank(a.key, keyOrder) - keyRank(b.key, keyOrder) || a.key.localeCompare(b.key) || a.index - b.index;
}

function scalarString(value: unknown): string | undefined {
  return isScalar(value) && typeof value.value === "string" ? value.value : undefined;
}

function collectYamlReferences(value: unknown): { anchors: Set<string>; aliases: Set<string> } {
  const anchors = new Set<string>();
  const aliases = new Set<string>();

  const visit = (node: unknown): void => {
    if (isAlias(node)) {
      aliases.add(node.source);
      return;
    }
    if (isScalar(node) || isMap(node) || isSeq(node)) {
      if (node.anchor) {
        anchors.add(node.anchor);
      }
    }
    if (isPair(node)) {
      visit(node.key);
      visit(node.value);
    } else if (isMap(node)) {
      node.items.forEach(visit);
    } else if (isSeq(node)) {
      node.items.forEach(visit);
    }
  };

  visit(value);
  return { anchors, aliases };
}

function keyRank(key: string, keyOrder: string[]): number {
  const index = keyOrder.indexOf(key);
  return index === -1 ? keyOrder.length : index;
}

function normalizeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function normalizeBody(body: string): string {
  const normalizedBody = body.replace(/\r\n?/g, "\n");
  const lines = normalizedBody.split("\n");
  if (normalizedBody.endsWith("\n")) {
    lines.pop();
  }
  const output: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let pendingBlankLine = false;

  for (const line of lines) {
    if (fence) {
      if (isClosingFence(line, fence)) {
        output.push(trimTrailingWhitespace(line));
        fence = undefined;
      } else {
        output.push(line);
      }
      continue;
    }

    const normalizedLine = trimTrailingWhitespace(line);
    const openingFence = parseOpeningFence(normalizedLine);
    if (openingFence) {
      if (pendingBlankLine && output.length > 0) {
        output.push("");
      }
      pendingBlankLine = false;
      output.push(normalizedLine);
      fence = openingFence;
    } else if (normalizedLine.length === 0) {
      pendingBlankLine = output.length > 0;
    } else {
      if (pendingBlankLine) {
        output.push("");
      }
      pendingBlankLine = false;
      output.push(normalizedLine);
    }
  }

  return `${output.join("\n")}\n`;
}

function trimTrailingWhitespace(line: string): string {
  return line.replace(/[ \t]+$/g, "");
}

function parseOpeningFence(line: string): { marker: "`" | "~"; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1].startsWith("`") && match[2].includes("`"))) {
    return undefined;
  }
  return {
    marker: match[1][0] as "`" | "~",
    length: match[1].length
  };
}

function isClosingFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

interface FrontmatterSplit {
  raw: string;
  body: string;
}

function splitFrontmatter(content: string): FrontmatterSplit | undefined {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return undefined;
  }

  const rest = content.slice(content.startsWith("---\r\n") ? 5 : 4);
  const closing = /^---[ \t]*\r?$/m.exec(rest);
  if (!closing || closing.index === undefined) {
    return undefined;
  }

  const raw = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length).replace(/^\r?\n/, "");
  return { raw, body };
}
