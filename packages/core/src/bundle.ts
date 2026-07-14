import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import fg from "fast-glob";

import { compareStrings } from "./compare.js";
import { loadConfig, mergeConfig, resolveConfig, type OkfxConfig, type ResolvedOkfxConfig } from "./config.js";
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
  await assertBundleRoot(root);
  const entries = await fg(config.include, {
    cwd: root,
    absolute: false,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: config.exclude
  });

  return entries.map((entry) => {
    const absoluteEntry = isAbsolute(entry) ? entry : resolve(root, entry);
    const relativePath = relative(root, absoluteEntry);
    if (
      !relativePath
      || relativePath === ".."
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new Error(`Discovered Markdown file escapes the OKF bundle root: ${absoluteEntry}`);
    }
    return relativePosixPath(root, absoluteEntry);
  }).sort(compareStrings);
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
      type: stringValue(ownFrontmatterValue(frontmatter, "type")) ?? "",
      title: stringValue(ownFrontmatterValue(frontmatter, "title")),
      description: stringValue(ownFrontmatterValue(frontmatter, "description")),
      resource: stringOrStringArray(ownFrontmatterValue(frontmatter, "resource")),
      tags: stringArray(ownFrontmatterValue(frontmatter, "tags")),
      timestamp: stringValue(ownFrontmatterValue(frontmatter, "timestamp")),
      frontmatter,
      frontmatterRaw: parsed.frontmatterRaw,
      body: parsed.body,
      links: parsed.links,
      contentHash: parsed.contentHash
    };
    concepts.push(concept);
  }

  const linkTargetIds = new Set([
    ...concepts.map((concept) => concept.id),
    ...indexes.map((file) => conceptIdFromPath(file.path)),
    ...logs.map((file) => conceptIdFromPath(file.path))
  ]);
  const allLinks = resolveLinks(
    [
      ...concepts.flatMap((concept) => concept.links.map((link) => ({ link, sourcePath: concept.path }))),
      ...indexes.flatMap((file) => file.links.map((link) => ({ link, sourcePath: file.path }))),
      ...logs.flatMap((file) => file.links.map((link) => ({ link, sourcePath: file.path })))
    ],
    linkTargetIds
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

async function assertBundleRoot(root: string): Promise<void> {
  const rootStat = await stat(root).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`OKF bundle root does not exist: ${root}`);
    }
    throw error;
  });

  if (!rootStat.isDirectory()) {
    throw new Error(`OKF bundle root is not a directory: ${root}`);
  }
}

function resolveLinks(
  entries: Array<{ link: LinkIR; sourcePath: string }>,
  linkTargetIds: Set<string>
): LinkIR[] {
  const resolved: LinkIR[] = [];

  for (const entry of entries) {
    if (entry.link.kind === "internal") {
      const targetConceptId = resolveMarkdownTarget(entry.sourcePath, entry.link.targetRaw);
      const isResolved = targetConceptId ? linkTargetIds.has(targetConceptId) : false;
      entry.link.targetConceptId = isResolved ? targetConceptId : undefined;
      entry.link.resolved = isResolved;
    } else if (entry.link.kind === "external" || entry.link.kind === "anchor") {
      entry.link.resolved = true;
    }

    resolved.push(entry.link);
  }

  return resolved;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function ownFrontmatterValue(frontmatter: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(frontmatter, key) ? frontmatter[key] : undefined;
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
