import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument, type Pair, type YAMLMap } from "yaml";

import { compareStrings } from "./compare.js";
import { loadConfig, mergeConfig, resolveConfig, type OkfxConfig, type ResolvedOkfxConfig } from "./config.js";
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
    document = parseDocument(split.raw.replace(/\r\n?/g, "\n"), { prettyErrors: false });
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
    : mergeConfig(await loadConfig(root), options.config);
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
  const entries: FrontmatterEntry[] = frontmatter.items.map((pair, index) => {
    const references = collectYamlReferences(pair);
    return {
      pair,
      index,
      key: scalarString(pair.key),
      ...references
    };
  });
  const anchorCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const anchor of entry.anchors) {
      anchorCounts.set(anchor, (anchorCounts.get(anchor) ?? 0) + 1);
    }
  }
  if ([...anchorCounts.values()].some((count) => count > 1)) {
    normalizeFrontmatterTimestamp(frontmatter);
    return;
  }

  const anchorOwners = new Map<string, number>();
  for (const entry of entries) {
    for (const anchor of entry.anchors) {
      anchorOwners.set(anchor, entry.index);
    }
  }

  const dependencies = entries.map((entry) => new Set([...entry.aliases]
    .map((alias) => anchorOwners.get(alias))
    .filter((owner): owner is number => owner !== undefined && owner !== entry.index)));
  const dependents = entries.map(() => [] as number[]);
  const indegrees = dependencies.map((owners) => owners.size);
  for (const [dependent, owners] of dependencies.entries()) {
    for (const owner of owners) {
      dependents[owner]!.push(dependent);
    }
  }

  const compareEntries = (a: FrontmatterEntry, b: FrontmatterEntry) => compareFrontmatterEntries(a, b, keyOrder);
  const remaining = new Set(entries.map((entry) => entry.index));
  const available: FrontmatterEntry[] = [];
  const allEntries: FrontmatterEntry[] = [];
  for (const entry of entries) {
    heapPush(allEntries, entry, compareEntries);
    if (indegrees[entry.index] === 0) {
      heapPush(available, entry, compareEntries);
    }
  }
  const ordered: Pair[] = [];
  while (remaining.size > 0) {
    const next = heapPopRemaining(available, remaining, compareEntries)
      ?? heapPopRemaining(allEntries, remaining, compareEntries)!;
    ordered.push(next.pair);
    remaining.delete(next.index);
    for (const dependent of dependents[next.index]!) {
      if (!remaining.has(dependent)) {
        continue;
      }
      indegrees[dependent] = indegrees[dependent]! - 1;
      if (indegrees[dependent] === 0) {
        heapPush(available, entries[dependent]!, compareEntries);
      }
    }
  }
  frontmatter.items = ordered;

  normalizeFrontmatterTimestamp(frontmatter);
}

interface FrontmatterEntry {
  pair: Pair;
  index: number;
  key?: string;
  anchors: string[];
  aliases: Set<string>;
}

function heapPush<T>(heap: T[], value: T, compare: (a: T, b: T) => number): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compare(heap[parent]!, value) <= 0) {
      break;
    }
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function heapPopRemaining<T extends { index: number }>(
  heap: T[],
  remaining: ReadonlySet<number>,
  compare: (a: T, b: T) => number
): T | undefined {
  while (heap.length > 0) {
    const value = heapPop(heap, compare)!;
    if (remaining.has(value.index)) {
      return value;
    }
  }
  return undefined;
}

function heapPop<T>(heap: T[], compare: (a: T, b: T) => number): T | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0) {
    return first;
  }

  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) {
      break;
    }
    const right = left + 1;
    const child = right < heap.length && compare(heap[right]!, heap[left]!) < 0 ? right : left;
    if (compare(last, heap[child]!) <= 0) {
      break;
    }
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

function normalizeFrontmatterTimestamp(frontmatter: YAMLMap): void {
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
  return keyRank(a.key, keyOrder) - keyRank(b.key, keyOrder) || compareStrings(a.key, b.key) || a.index - b.index;
}

function scalarString(value: unknown): string | undefined {
  return isScalar(value) && typeof value.value === "string" ? value.value : undefined;
}

function collectYamlReferences(value: unknown): { anchors: string[]; aliases: Set<string> } {
  const anchors: string[] = [];
  const aliases = new Set<string>();

  const visit = (node: unknown): void => {
    if (isAlias(node)) {
      aliases.add(node.source);
      return;
    }
    if (isScalar(node) || isMap(node) || isSeq(node)) {
      if (node.anchor) {
        anchors.push(node.anchor);
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
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!date) {
    return value;
  }

  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    return value;
  }

  return `${value}T00:00:00.000Z`;
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
  const opening = /^---(\r\n|\n|\r)/.exec(content);
  if (!opening) {
    return undefined;
  }

  const rest = content.slice(opening[0].length);
  const closing = /^---[ \t]*\r?$/m.exec(rest);
  if (!closing || closing.index === undefined) {
    return undefined;
  }

  const raw = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length).replace(/^(?:\r\n|\n|\r)/, "");
  return { raw, body };
}
