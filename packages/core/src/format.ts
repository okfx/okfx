import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseDocument, stringify } from "yaml";

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

  let frontmatter: unknown;
  try {
    const document = parseDocument(split.raw, { prettyErrors: false });
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
    frontmatter = document.toJSON();
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

  if (!isRecord(frontmatter)) {
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

  const formattedFrontmatter = stringify(orderFrontmatter(frontmatter, resolved.frontmatter.keyOrder), {
    lineWidth: 0,
    sortMapEntries: false
  }).trimEnd();
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

function orderFrontmatter(frontmatter: Record<string, unknown>, keyOrder: string[]): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  const keys = Object.keys(frontmatter).sort((a, b) => keyRank(a, keyOrder) - keyRank(b, keyOrder) || a.localeCompare(b));

  for (const key of keys) {
    const value = key === "timestamp" && typeof frontmatter[key] === "string"
      ? normalizeTimestamp(frontmatter[key])
      : frontmatter[key];
    ordered[key] = value;
  }

  return ordered;
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
  return `${body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s*$/g, "")}\n`;
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
  const closing = /^---\s*$/m.exec(rest);
  if (!closing || closing.index === undefined) {
    return undefined;
  }

  const raw = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length).replace(/^\r?\n/, "");
  return { raw, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
