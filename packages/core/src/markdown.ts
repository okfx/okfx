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
  return {
    body: {
      raw: bodyRaw,
      text: plainText(bodyRaw),
      headings: extractHeadings(bodyRaw, bodyStartOffset, bodyStartLine)
    },
    links: extractLinks(bodyRaw, sourceConceptId, bodyStartOffset, bodyStartLine)
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
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
