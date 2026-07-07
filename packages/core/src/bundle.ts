import { readFile } from "node:fs/promises";
import { join } from "node:path";

import fg from "fast-glob";

import { loadConfig, resolveConfig, type OkfxConfig, type ResolvedOkfxConfig } from "./config.js";
import { parseMarkdownDocument } from "./parser.js";
import {
  conceptIdFromPath,
  isReservedMarkdownFile,
  relativePosixPath,
  reservedFileKind,
  resolveBundleRoot,
  resolveMarkdownTarget
} from "./paths.js";
import type { BundleIR, ConceptIR, DiagnosticIR, IndexFileIR, LinkIR, LogFileIR } from "./types.js";

export interface LoadBundleOptions {
  config?: OkfxConfig;
  loadConfigFile?: boolean;
}

export async function discoverMarkdownFiles(root: string, config: ResolvedOkfxConfig): Promise<string[]> {
  const entries = await fg(config.include, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: config.exclude
  });

  return entries.map((entry) => relativePosixPath(root, entry)).sort((a, b) => a.localeCompare(b));
}

export async function loadBundle(rootInput: string, options: LoadBundleOptions = {}): Promise<BundleIR> {
  const root = resolveBundleRoot(rootInput);
  const config = options.loadConfigFile === false
    ? resolveConfig(options.config)
    : mergeConfig(await loadConfig(root), options.config);
  const files = await discoverMarkdownFiles(root, config);
  const concepts: ConceptIR[] = [];
  const indexes: IndexFileIR[] = [];
  const logs: LogFileIR[] = [];
  const diagnostics: DiagnosticIR[] = [];

  for (const path of files) {
    const content = await readFile(join(root, path), "utf8");
    const sourceConceptId = conceptIdFromPath(path);
    const parsed = parseMarkdownDocument(path, content, sourceConceptId);
    diagnostics.push(...parsed.diagnostics);

    if (isReservedMarkdownFile(path)) {
      const reservedKind = reservedFileKind(path);
      if (reservedKind === "index") {
        indexes.push({
          path,
          body: parsed.body,
          links: parsed.links,
          contentHash: parsed.contentHash
        });
      } else {
        logs.push({
          path,
          body: parsed.body,
          links: parsed.links,
          contentHash: parsed.contentHash
        });
      }
      continue;
    }

    const frontmatter = parsed.frontmatter ?? {};
    const concept: ConceptIR = {
      id: sourceConceptId,
      path,
      type: stringValue(frontmatter.type) ?? "",
      title: stringValue(frontmatter.title),
      description: stringValue(frontmatter.description),
      resource: stringOrStringArray(frontmatter.resource),
      tags: stringArray(frontmatter.tags),
      timestamp: stringValue(frontmatter.timestamp),
      frontmatter,
      body: parsed.body,
      links: parsed.links,
      contentHash: parsed.contentHash
    };
    concepts.push(concept);
  }

  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const allLinks = resolveLinks(
    [
      ...concepts.flatMap((concept) => concept.links.map((link) => ({ link, sourcePath: concept.path }))),
      ...indexes.flatMap((file) => file.links.map((link) => ({ link, sourcePath: file.path }))),
      ...logs.flatMap((file) => file.links.map((link) => ({ link, sourcePath: file.path })))
    ],
    conceptIds
  );

  const brokenLinkCount = allLinks.filter((link) => link.kind === "internal" && !link.resolved).length;

  return {
    root,
    okfVersion: config.okfVersion,
    concepts,
    indexes,
    logs,
    links: allLinks,
    diagnostics,
    stats: {
      fileCount: files.length,
      conceptCount: concepts.length,
      indexCount: indexes.length,
      logCount: logs.length,
      linkCount: allLinks.length,
      brokenLinkCount,
      diagnosticCount: diagnostics.length
    }
  };
}

function resolveLinks(
  entries: Array<{ link: LinkIR; sourcePath: string }>,
  conceptIds: Set<string>
): LinkIR[] {
  const resolved: LinkIR[] = [];

  for (const entry of entries) {
    if (entry.link.kind === "internal") {
      const targetConceptId = resolveMarkdownTarget(entry.sourcePath, entry.link.targetRaw);
      const isResolved = targetConceptId ? conceptIds.has(targetConceptId) : false;
      entry.link.targetConceptId = isResolved ? targetConceptId : undefined;
      entry.link.resolved = isResolved;
    } else if (entry.link.kind === "external" || entry.link.kind === "anchor") {
      entry.link.resolved = true;
    }

    resolved.push(entry.link);
  }

  return resolved;
}

function mergeConfig(base: ResolvedOkfxConfig, override: OkfxConfig = {}): ResolvedOkfxConfig {
  const resolvedOverride = resolveConfig(override, base.configPath);
  return {
    ...base,
    ...resolvedOverride,
    include: override.include ?? base.include,
    exclude: override.exclude ?? base.exclude,
    presets: override.presets ?? base.presets,
    rules: override.rules ?? base.rules,
    frontmatter: {
      keyOrder: override.frontmatter?.keyOrder ?? base.frontmatter.keyOrder
    },
    resourcePolicy: {
      allowHosts: override.resourcePolicy?.allowHosts ?? base.resourcePolicy.allowHosts
    },
    mcp: {
      readonly: override.mcp?.readonly ?? base.mcp.readonly,
      exposeDiagnostics: override.mcp?.exposeDiagnostics ?? base.mcp.exposeDiagnostics,
      exposeGraph: override.mcp?.exposeGraph ?? base.mcp.exposeGraph
    },
    configPath: base.configPath
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function stringOrStringArray(value: unknown): string | string[] | undefined {
  if (typeof value === "string") {
    return value;
  }

  return stringArray(value);
}
