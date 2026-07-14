import { parseDocument } from "yaml";

import { contentHash } from "./hash.js";
import { extractMarkdown } from "./markdown.js";
import type { DiagnosticIR, LinkIR, MarkdownBodyIR } from "./types.js";

export interface ParsedMarkdownDocument {
  path: string;
  frontmatter?: Record<string, unknown>;
  frontmatterRaw?: string;
  body: MarkdownBodyIR;
  links: LinkIR[];
  diagnostics: DiagnosticIR[];
  contentHash: string;
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

    try {
      const document = parseDocument(frontmatterRaw.replace(/\r\n?/g, "\n"), { prettyErrors: false });
      if (document.errors.length > 0) {
        throw document.errors[0];
      }

      const value = document.toJSON();
      if (!isPlainRecord(value)) {
        diagnostics.push(invalidFrontmatter(path, "Frontmatter must be a YAML mapping."));
      } else {
        frontmatter = value;
      }
    } catch (error) {
      diagnostics.push(invalidFrontmatter(path, error instanceof Error ? error.message : "Could not parse YAML frontmatter."));
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
