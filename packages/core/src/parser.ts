import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";

import { contentHash } from "./hash.js";
import { extractMarkdown } from "./markdown.js";
import type { DiagnosticIR, LinkIR, MarkdownBodyIR } from "./types.js";

const MAX_YAML_COLLECTION_NESTING = 200;
const YAML_NESTING_ERROR = "Frontmatter must not contain more than 200 nested collections.";

export interface ParsedMarkdownDocument {
  path: string;
  frontmatter?: Record<string, unknown>;
  frontmatterRaw?: string;
  body: MarkdownBodyIR;
  links: LinkIR[];
  diagnostics: DiagnosticIR[];
  contentHash: string;
}

export type ParsedYamlFrontmatter =
  | {
    ok: true;
    document: ReturnType<typeof parseDocument>;
    map: YAMLMap;
    frontmatter: Record<string, unknown>;
  }
  | {
    ok: false;
    diagnostic: DiagnosticIR;
  };

export function parseYamlFrontmatter(path: string, raw: string): ParsedYamlFrontmatter {
  try {
    const document = parseDocument(raw.replace(/\r\n?/g, "\n"), { prettyErrors: false });
    if (document.errors.length > 0) {
      throw document.errors[0];
    }

    if (!isMap(document.contents) || !validRootMappingTag(document.contents.tag)) {
      return { ok: false, diagnostic: invalidFrontmatter(path, "Frontmatter must be a YAML mapping.") };
    }
    if (exceedsYamlCollectionNesting(document.contents)) {
      return { ok: false, diagnostic: invalidFrontmatter(path, YAML_NESTING_ERROR) };
    }
    if (!hasOnlyStringMappingKeys(document.contents)) {
      return { ok: false, diagnostic: invalidFrontmatter(path, "Frontmatter keys must be strings.") };
    }
    if (!hasValidExplicitYamlTags(document.contents)) {
      return {
        ok: false,
        diagnostic: invalidFrontmatter(path, "Frontmatter contains an invalid explicit YAML tag value.")
      };
    }

    const value = document.toJSON();
    if (!isPlainRecord(value)) {
      return { ok: false, diagnostic: invalidFrontmatter(path, "Frontmatter must be a YAML mapping.") };
    }
    if (!hasOnlyStringCollectionKeys(value)) {
      return { ok: false, diagnostic: invalidFrontmatter(path, "Frontmatter keys must be strings.") };
    }
    if (containsReferenceCycle(value)) {
      return {
        ok: false,
        diagnostic: invalidFrontmatter(path, "Frontmatter must not contain recursive YAML aliases.")
      };
    }
    if (containsNonFiniteNumber(value)) {
      return { ok: false, diagnostic: invalidFrontmatter(path, "Frontmatter numbers must be finite.") };
    }

    return {
      ok: true,
      document,
      map: document.contents,
      frontmatter: normalizeYamlJsonValue(document.contents, value, document) as Record<string, unknown>
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: invalidFrontmatter(
        path,
        error instanceof Error ? error.message : "Could not parse YAML frontmatter."
      )
    };
  }
}

export function parseMarkdownDocument(path: string, content: string, sourceConceptId: string): ParsedMarkdownDocument {
  const diagnostics: DiagnosticIR[] = [];
  const frontmatterBlock = splitFrontmatter(content);
  let frontmatter: Record<string, unknown> | undefined;
  let frontmatterRaw: string | undefined;
  let bodyRaw = content;
  let bodyStartOffset = 0;
  let bodyStartLine = 1;

  if (frontmatterBlock) {
    frontmatterRaw = frontmatterBlock.raw;
    bodyRaw = frontmatterBlock.body;
    bodyStartOffset = frontmatterBlock.bodyStartOffset;
    bodyStartLine = frontmatterBlock.bodyStartLine;

    const parsed = parseYamlFrontmatter(path, frontmatterRaw);
    if (parsed.ok) {
      frontmatter = parsed.frontmatter;
    } else {
      diagnostics.push(parsed.diagnostic);
    }
  }

  const markdown = extractMarkdown(bodyRaw, sourceConceptId, bodyStartOffset, bodyStartLine);

  return {
    path,
    frontmatter,
    frontmatterRaw,
    body: markdown.body,
    links: markdown.links,
    diagnostics,
    contentHash: contentHash(content)
  };
}

interface FrontmatterBlock {
  raw: string;
  body: string;
  bodyStartOffset: number;
  bodyStartLine: number;
}

function splitFrontmatter(content: string): FrontmatterBlock | undefined {
  const opening = /^---(\r\n|\n|\r)/.exec(content);
  if (!opening) {
    return undefined;
  }

  const openingLength = opening[0].length;
  const closingPattern = /^---[ \t]*\r?$/m;
  const rest = content.slice(openingLength);
  const closing = closingPattern.exec(rest);
  if (!closing || closing.index === undefined) {
    return undefined;
  }

  const raw = rest.slice(0, closing.index);
  const closingEndOffset = openingLength + closing.index + closing[0].length;
  const closingLineEnding = /^(?:\r\n|\n|\r)/.exec(content.slice(closingEndOffset))?.[0] ?? "";
  const bodyStartOffset = closingEndOffset + closingLineEnding.length;
  return {
    raw,
    body: content.slice(bodyStartOffset),
    bodyStartOffset,
    bodyStartLine: content.slice(0, bodyStartOffset).split(/\r\n|\n|\r/).length
  };
}

function invalidFrontmatter(path: string, message: string): DiagnosticIR {
  return {
    code: "spec/invalid-frontmatter",
    severity: "error",
    message,
    path,
    location: {
      start: {
        line: 1,
        column: 1,
        offset: 0
      }
    }
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exceedsYamlCollectionNesting(value: unknown): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() ?? { node: undefined, depth: 0 };
    if (isPair(node)) {
      stack.push({ node: node.key, depth }, { node: node.value, depth });
      continue;
    }
    if (!isMap(node) && !isSeq(node)) {
      continue;
    }

    const childDepth = depth + 1;
    if (childDepth > MAX_YAML_COLLECTION_NESTING) {
      return true;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        stack.push({ node: pair, depth: childDepth });
      }
    } else {
      for (const item of node.items) {
        stack.push({ node: item, depth: childDepth });
      }
    }
  }
  return false;
}

function hasOnlyStringMappingKeys(value: unknown): boolean {
  const stack = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isPair(node)) {
      if (!isScalar(node.key) || typeof node.key.value !== "string") {
        return false;
      }
      stack.push(node.value);
    } else if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          return false;
        }
        stack.push(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) {
        stack.push(item);
      }
    }
  }
  return true;
}

function validRootMappingTag(tag: string | undefined): boolean {
  return tag === undefined
    || tag === "tag:yaml.org,2002:map"
    || tag === "tag:yaml.org,2002:set";
}

function hasValidExplicitYamlTags(value: unknown): boolean {
  const stack = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isAlias(node)) {
      continue;
    }
    if (isPair(node)) {
      stack.push(node.key, node.value);
    } else if (isScalar(node)) {
      if (!validScalarTagValue(node.tag, node.value)) {
        return false;
      }
    } else if (isMap(node)) {
      if (node.tag?.startsWith("tag:yaml.org,2002:")
        && node.tag !== "tag:yaml.org,2002:map"
        && node.tag !== "tag:yaml.org,2002:set") {
        return false;
      }
      for (const pair of node.items) {
        stack.push(pair.key, pair.value);
      }
    } else if (isSeq(node)) {
      if (node.tag?.startsWith("tag:yaml.org,2002:")
        && node.tag !== "tag:yaml.org,2002:seq"
        && node.tag !== "tag:yaml.org,2002:omap"
        && node.tag !== "tag:yaml.org,2002:pairs") {
        return false;
      }
      for (const item of node.items) {
        stack.push(item);
      }
    }
  }
  return true;
}

function validScalarTagValue(tag: string | undefined, value: unknown): boolean {
  if (!tag || !tag.startsWith("tag:yaml.org,2002:")) {
    return true;
  }
  switch (tag) {
    case "tag:yaml.org,2002:str":
      return typeof value === "string";
    case "tag:yaml.org,2002:int":
      return typeof value === "number" && Number.isInteger(value);
    case "tag:yaml.org,2002:float":
      return typeof value === "number";
    case "tag:yaml.org,2002:bool":
      return typeof value === "boolean";
    case "tag:yaml.org,2002:null":
      return value === null;
    case "tag:yaml.org,2002:timestamp":
      return value instanceof Date;
    case "tag:yaml.org,2002:binary":
      return Buffer.isBuffer(value);
    default:
      return false;
  }
}

function hasOnlyStringCollectionKeys(value: unknown): boolean {
  const stack = [value];
  const visited = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current instanceof Map) {
      for (const [key, child] of current) {
        if (typeof key !== "string") {
          return false;
        }
        stack.push(child);
      }
    } else if (current instanceof Set) {
      for (const key of current) {
        if (typeof key !== "string") {
          return false;
        }
      }
    } else {
      for (const child of Object.values(current)) {
        stack.push(child);
      }
    }
  }
  return true;
}

function normalizeYamlJsonValue(
  node: unknown,
  value: unknown,
  document: ReturnType<typeof parseDocument>
): unknown {
  // Match serde_yaml's JSON boundary instead of leaking Map, Set, Buffer, or Date values into the IR.
  if (isAlias(node)) {
    return normalizeYamlJsonValue(node.resolve(document), value, document);
  }
  if (isScalar(node)) {
    const normalized = node.tag === "tag:yaml.org,2002:timestamp"
      || node.tag === "tag:yaml.org,2002:binary"
      ? node.source ?? String(value)
      : value;
    return wrapCustomYamlTag(node.tag, normalized);
  }
  if (isMap(node)) {
    const normalized = createJsonRecord();
    for (const pair of node.items) {
      const key = isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : "";
      const child = value instanceof Set
        ? null
        : isPlainRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
      defineJsonProperty(normalized, key, normalizeYamlJsonValue(pair.value, child, document));
    }
    return wrapCustomYamlTag(node.tag, normalized);
  }
  if (isSeq(node)) {
    if (node.tag === "tag:yaml.org,2002:omap" || node.tag === "tag:yaml.org,2002:pairs") {
      const values = value instanceof Map ? [...value].map(([key, child]) => ({ [key]: child })) : value;
      return node.items.map((item, index) => {
        if (!isPair(item) || !isScalar(item.key) || typeof item.key.value !== "string") {
          return createJsonRecord();
        }
        const key = item.key.value;
        const childRecord = Array.isArray(values) ? values[index] : undefined;
        const child = isPlainRecord(childRecord) && Object.hasOwn(childRecord, key)
          ? childRecord[key]
          : undefined;
        const entry = createJsonRecord();
        defineJsonProperty(entry, key, normalizeYamlJsonValue(item.value, child, document));
        return entry;
      });
    }
    const values = Array.isArray(value) ? value : node.items;
    const normalized = values.map((child, index) => normalizeYamlJsonValue(
      node.items[index],
      child,
      document
    ));
    return wrapCustomYamlTag(node.tag, normalized);
  }
  return normalizePlainJsonValue(value);
}

function wrapCustomYamlTag(tag: string | undefined, value: unknown): unknown {
  if (!tag || tag.startsWith("tag:yaml.org,2002:")) {
    return value;
  }
  const normalizedTag = decodeYamlTag(tag);
  const wrapped = createJsonRecord();
  defineJsonProperty(wrapped, normalizedTag.startsWith("!") ? normalizedTag : `!${normalizedTag}`, value);
  return wrapped;
}

function decodeYamlTag(tag: string): string {
  try {
    return decodeURIComponent(tag);
  } catch {
    return tag;
  }
}

function normalizePlainJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizePlainJsonValue);
  }
  if (value instanceof Map) {
    return [...value].map(([key, child]) => {
      const entry = createJsonRecord();
      if (typeof key === "string") {
        defineJsonProperty(entry, key, normalizePlainJsonValue(child));
      }
      return entry;
    });
  }
  if (value instanceof Set) {
    const normalized = createJsonRecord();
    for (const key of value) {
      if (typeof key === "string") {
        defineJsonProperty(normalized, key, null);
      }
    }
    return normalized;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const normalized = createJsonRecord();
  for (const [key, child] of Object.entries(value)) {
    defineJsonProperty(normalized, key, normalizePlainJsonValue(child));
  }
  return normalized;
}

function createJsonRecord(): Record<string, unknown> {
  return {};
}

function defineJsonProperty(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function containsReferenceCycle(value: unknown): boolean {
  const visiting = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const stack: Array<{ value: unknown; exiting: boolean }> = [{ value, exiting: false }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (typeof frame.value !== "object" || frame.value === null) {
      continue;
    }
    if (frame.exiting) {
      visiting.delete(frame.value);
      visited.add(frame.value);
      continue;
    }
    if (visiting.has(frame.value)) {
      return true;
    }
    if (visited.has(frame.value)) {
      continue;
    }

    visiting.add(frame.value);
    stack.push({ value: frame.value, exiting: true });
    for (const child of referenceChildren(frame.value)) {
      stack.push({ value: child, exiting: false });
    }
  }

  return false;
}

function containsNonFiniteNumber(value: unknown): boolean {
  const stack = [value];
  const visited = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return true;
      }
      continue;
    }
    if (typeof current !== "object" || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const child of referenceChildren(current)) {
      stack.push(child);
    }
  }
  return false;
}

function referenceChildren(value: object): unknown[] {
  if (value instanceof Map) {
    return [...value.keys(), ...value.values()];
  }
  if (value instanceof Set) {
    return [...value.values()];
  }
  return Object.values(value);
}
