import type { HeadingIR, LinkIR, LinkKind, MarkdownBodyIR, SourceLocationIR } from "./types.js";

export interface ExtractedMarkdown {
  body: MarkdownBodyIR;
  links: LinkIR[];
}

export function extractMarkdown(
  bodyRaw: string,
  sourceConceptId: string,
  bodyStartOffset: number,
  bodyStartLine = 1
): ExtractedMarkdown {
  const searchableBody = maskFencedCode(bodyRaw);
  const linkSearchableBody = maskInlineCode(searchableBody);
  return {
    body: {
      raw: bodyRaw,
      text: plainText(bodyRaw),
      headings: extractHeadings(searchableBody, bodyStartOffset, bodyStartLine)
    },
    links: extractLinks(linkSearchableBody, sourceConceptId, bodyStartOffset, bodyStartLine)
  };
}

export function classifyLinkTarget(targetRaw: string): LinkKind {
  if (targetRaw.startsWith("#")) {
    return "anchor";
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(targetRaw) || targetRaw.startsWith("//")) {
    return "external";
  }

  if (targetRaw.trim().length === 0) {
    return "unknown";
  }

  return "internal";
}

function extractHeadings(bodyRaw: string, bodyStartOffset: number, bodyStartLine: number): HeadingIR[] {
  const headings: HeadingIR[] = [];
  const headingPattern = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/gm;

  for (const match of bodyRaw.matchAll(headingPattern)) {
    const rawTitle = match[2] ?? "";
    const startOffset = bodyStartOffset + (match.index ?? 0);
    headings.push({
      level: match[1]?.length ?? 1,
      title: rawTitle.trim(),
      slug: slugifyHeading(rawTitle),
      location: {
        start: locationFromOffset(bodyRaw, match.index ?? 0, bodyStartOffset, bodyStartLine),
        end: locationFromOffset(bodyRaw, (match.index ?? 0) + match[0].length, bodyStartOffset, bodyStartLine)
      }
    });
  }

  return headings;
}

function extractLinks(bodyRaw: string, sourceConceptId: string, bodyStartOffset: number, bodyStartLine: number): LinkIR[] {
  const links: LinkIR[] = [];
  const linkPattern = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

  for (const match of bodyRaw.matchAll(linkPattern)) {
    const targetRaw = match[2] ?? "";
    const startOffset = match.index ?? 0;
    links.push({
      sourceConceptId,
      targetRaw,
      text: match[1]?.trim(),
      kind: classifyLinkTarget(targetRaw),
      resolved: false,
      location: {
        start: locationFromOffset(bodyRaw, startOffset, bodyStartOffset, bodyStartLine),
        end: locationFromOffset(bodyRaw, startOffset + match[0].length, bodyStartOffset, bodyStartLine)
      }
    });
  }

  return links;
}

export function slugifyHeading(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function plainText(markdown: string): string {
  return maskFencedCode(markdown)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function maskFencedCode(markdown: string): string {
  const segments = markdown.split(/(\r\n|\n|\r)/);
  let fence: { marker: "`" | "~"; length: number } | undefined;

  return segments.map((segment, index) => {
    if (index % 2 === 1) {
      return segment;
    }
    if (fence) {
      if (isClosingFence(segment, fence)) {
        fence = undefined;
      }
      return " ".repeat(segment.length);
    }

    const openingFence = parseOpeningFence(segment);
    if (!openingFence) {
      return segment;
    }
    fence = openingFence;
    return " ".repeat(segment.length);
  }).join("");
}

function maskInlineCode(markdown: string): string {
  const chunks: string[] = [];
  let emittedThrough = 0;
  let cursor = 0;

  while (cursor < markdown.length) {
    const opener = markdown.indexOf("`", cursor);
    if (opener === -1) {
      break;
    }
    if (isEscaped(markdown, opener)) {
      cursor = opener + 1;
      continue;
    }

    const delimiterLength = backtickRunLength(markdown, opener);
    let searchFrom = opener + delimiterLength;
    let closingEnd: number | undefined;
    while (searchFrom < markdown.length) {
      const candidate = markdown.indexOf("`", searchFrom);
      if (candidate === -1) {
        break;
      }
      const candidateLength = backtickRunLength(markdown, candidate);
      if (candidateLength === delimiterLength) {
        closingEnd = candidate + candidateLength;
        break;
      }
      searchFrom = candidate + candidateLength;
    }

    if (closingEnd === undefined) {
      cursor = opener + delimiterLength;
      continue;
    }

    chunks.push(markdown.slice(emittedThrough, opener));
    chunks.push(markdown.slice(opener, closingEnd).replace(/[^\r\n]/g, " "));
    emittedThrough = closingEnd;
    cursor = closingEnd;
  }

  chunks.push(markdown.slice(emittedThrough));
  return chunks.join("");
}

function backtickRunLength(value: string, start: number): number {
  let end = start;
  while (value[end] === "`") {
    end += 1;
  }
  return end - start;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
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

function locationFromOffset(
  bodyRaw: string,
  bodyOffset: number,
  bodyStartOffset: number,
  bodyStartLine: number
): SourceLocationIR {
  const absoluteOffset = bodyStartOffset + bodyOffset;
  const prefix = bodyRaw.slice(0, bodyOffset);
  const lines = prefix.split("\n");
  return {
    line: bodyStartLine + lines.length - 1,
    column: lines[lines.length - 1]!.length + 1,
    offset: absoluteOffset
  };
}
