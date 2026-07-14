import type { HeadingIR, LinkIR, LinkKind, MarkdownBodyIR, SourceLocationIR } from "./types.js";
import { unescapeMarkdownDestination } from "./markdown-destination.js";

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
  const locate = createSourceLocator(bodyRaw, bodyStartOffset, bodyStartLine);
  return {
    body: {
      raw: bodyRaw,
      text: plainText(bodyRaw),
      headings: extractHeadings(searchableBody, locate)
    },
    links: extractLinks(linkSearchableBody, sourceConceptId, locate)
  };
}

export function classifyLinkTarget(targetRaw: string): LinkKind {
  const target = unescapeMarkdownDestination(targetRaw);
  if (target.startsWith("#")) {
    return "anchor";
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
    return "external";
  }

  if (target.trim().length === 0) {
    return "unknown";
  }

  return "internal";
}

function extractHeadings(bodyRaw: string, locate: SourceLocator): HeadingIR[] {
  const headings: HeadingIR[] = [];
  const headingPattern = /^ {0,3}#+[^\r\n]*$/gm;

  for (const match of bodyRaw.matchAll(headingPattern)) {
    const heading = parseAtxHeading(match[0]);
    if (!heading) {
      continue;
    }
    headings.push({
      level: heading.level,
      title: heading.title,
      slug: slugifyHeading(heading.title),
      location: {
        start: locate(match.index ?? 0),
        end: locate((match.index ?? 0) + match[0].length)
      }
    });
  }

  return headings;
}

function extractLinks(bodyRaw: string, sourceConceptId: string, locate: SourceLocator): LinkIR[] {
  const links: LinkIR[] = [];
  const labelEnds = matchingLinkLabelEnds(bodyRaw);
  let cursor = 0;

  while (cursor < bodyRaw.length) {
    const startOffset = bodyRaw.indexOf("[", cursor);
    if (startOffset === -1) {
      break;
    }
    if (isEscaped(bodyRaw, startOffset)) {
      cursor = startOffset + 1;
      continue;
    }
    if (bodyRaw[startOffset - 1] === "!" && !isEscaped(bodyRaw, startOffset - 1)) {
      cursor = startOffset + 1;
      continue;
    }

    const labelEnd = labelEnds.get(startOffset);
    if (labelEnd === undefined || bodyRaw[labelEnd + 1] !== "(") {
      cursor = startOffset + 1;
      continue;
    }
    if (linkLabelContainsLink(bodyRaw, startOffset + 1, labelEnd, labelEnds)) {
      cursor = startOffset + 1;
      continue;
    }
    const destination = parseLinkDestination(bodyRaw, labelEnd + 2);
    if (!destination) {
      cursor = labelEnd + 1;
      continue;
    }

    const targetRaw = bodyRaw.slice(destination.targetStart, destination.targetEnd);
    const text = bodyRaw.slice(startOffset + 1, labelEnd).trim();
    links.push({
      sourceConceptId,
      targetRaw,
      text: text || undefined,
      kind: classifyLinkTarget(targetRaw),
      resolved: false,
      location: {
        start: locate(startOffset),
        end: locate(destination.closingParen + 1)
      }
    });
    cursor = destination.closingParen + 1;
  }

  return links;
}

function parseLinkDestination(
  markdown: string,
  targetStart: number
): { targetStart: number; targetEnd: number; closingParen: number } | undefined {
  let destinationStart = targetStart;
  while (destinationStart < markdown.length && /[ \t]/u.test(markdown[destinationStart] ?? "")) {
    destinationStart += 1;
  }

  if (destinationStart > targetStart
    && (markdown[destinationStart] === ")"
      || markdown[destinationStart] === "\""
      || markdown[destinationStart] === "'"
      || markdown[destinationStart] === "(")) {
    return parseLinkDestinationTail(markdown, targetStart, destinationStart, destinationStart);
  }

  if (markdown[destinationStart] === "<") {
    let cursor = destinationStart + 1;
    while (cursor < markdown.length) {
      const character = markdown[cursor];
      if (character === "\r" || character === "\n" || (character === "<" && !isEscaped(markdown, cursor))) {
        return undefined;
      }
      if (character === ">" && !isEscaped(markdown, cursor)) {
        return parseLinkDestinationTail(markdown, cursor + 1, destinationStart + 1, cursor);
      }
      cursor += 1;
    }
    return undefined;
  }

  let depth = 0;
  let cursor = destinationStart;

  while (cursor < markdown.length) {
    const character = markdown[cursor];
    if (character === "\r" || character === "\n") {
      return undefined;
    }
    if (character === "(" && !isEscaped(markdown, cursor)) {
      depth += 1;
    } else if (character === ")" && !isEscaped(markdown, cursor)) {
      if (depth === 0) {
        return { targetStart: destinationStart, targetEnd: cursor, closingParen: cursor };
      }
      depth -= 1;
    } else if (/\s/u.test(character ?? "")) {
      if (depth !== 0) {
        return undefined;
      }
      return parseLinkDestinationTail(markdown, cursor, destinationStart, cursor);
    }
    cursor += 1;
  }

  return undefined;
}

function parseLinkDestinationTail(
  markdown: string,
  tailStart: number,
  targetStart: number,
  targetEnd: number
): { targetStart: number; targetEnd: number; closingParen: number } | undefined {
  let cursor = tailStart;
  while (cursor < markdown.length && /[ \t]/u.test(markdown[cursor] ?? "")) {
    cursor += 1;
  }
  const hasTitleSeparator = cursor > tailStart;
  if (markdown[cursor] === ")") {
    return { targetStart, targetEnd, closingParen: cursor };
  }
  if (!hasTitleSeparator) {
    return undefined;
  }

  const quote = markdown[cursor];
  if (quote !== "\"" && quote !== "'" && quote !== "(") {
    return undefined;
  }
  const closingQuote = quote === "(" ? ")" : quote;

  cursor += 1;
  while (cursor < markdown.length) {
    const character = markdown[cursor];
    if (character === "\r" || character === "\n") {
      return undefined;
    }
    if (character === closingQuote && !isEscaped(markdown, cursor)) {
      let closingParen = cursor + 1;
      while (closingParen < markdown.length && /[ \t]/u.test(markdown[closingParen] ?? "")) {
        closingParen += 1;
      }
      return markdown[closingParen] === ")"
        ? { targetStart, targetEnd, closingParen }
        : undefined;
    }
    cursor += 1;
  }

  return undefined;
}

function matchingLinkLabelEnds(value: string): Map<number, number> {
  const ends = new Map<number, number>();
  const stack: number[] = [];
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (character === "\r" || character === "\n") {
      stack.length = 0;
      continue;
    }
    if (isEscaped(value, cursor)) {
      continue;
    }
    if (character === "[") {
      stack.push(cursor);
    } else if (character === "]") {
      const start = stack.pop();
      if (start !== undefined) {
        ends.set(start, cursor);
      }
    }
  }
  return ends;
}

function linkLabelContainsLink(
  value: string,
  start: number,
  end: number,
  labelEnds: Map<number, number>
): boolean {
  let cursor = start;
  while (cursor < end) {
    const nestedStart = value.indexOf("[", cursor);
    if (nestedStart === -1 || nestedStart >= end) {
      return false;
    }
    if (isEscaped(value, nestedStart)
      || (value[nestedStart - 1] === "!" && !isEscaped(value, nestedStart - 1))) {
      cursor = nestedStart + 1;
      continue;
    }

    const nestedEnd = labelEnds.get(nestedStart);
    if (nestedEnd !== undefined && nestedEnd < end && value[nestedEnd + 1] === "(") {
      const destination = parseLinkDestination(value, nestedEnd + 2);
      if (destination && destination.closingParen < end) {
        return true;
      }
    }
    cursor = nestedStart + 1;
  }

  return false;
}

export function slugifyHeading(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{Alphabetic}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function plainText(markdown: string): string {
  return stripInlineLinks(maskFencedCode(markdown))
    .replace(/^ {0,3}#+[^\r\n]*$/gm, (line) => parseAtxHeading(line)?.title ?? line)
    .replace(/`+/g, "")
    .replace(/[`*_~>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAtxHeading(line: string): { level: number; title: string } | undefined {
  const match = /^ {0,3}(#+)(.*)$/.exec(line);
  if (!match || match[1].length > 6) {
    return undefined;
  }

  const remainder = match[2] ?? "";
  if (remainder.length > 0 && remainder[0] !== " " && remainder[0] !== "\t") {
    return undefined;
  }

  return {
    level: match[1].length,
    title: remainder
      .replace(/[ \t]+#+[ \t]*$/, "")
      .replace(/^[ \t]+|[ \t]+$/g, "")
  };
}

function stripInlineLinks(markdown: string): string {
  const chunks: string[] = [];
  const labelEnds = matchingLinkLabelEnds(markdown);
  let emittedThrough = 0;
  let cursor = 0;

  while (cursor < markdown.length) {
    const startOffset = markdown.indexOf("[", cursor);
    if (startOffset === -1) {
      break;
    }
    if (isEscaped(markdown, startOffset)) {
      cursor = startOffset + 1;
      continue;
    }

    const image = markdown[startOffset - 1] === "!" && !isEscaped(markdown, startOffset - 1);
    const labelEnd = labelEnds.get(startOffset);
    if (labelEnd === undefined || markdown[labelEnd + 1] !== "(") {
      cursor = startOffset + 1;
      continue;
    }
    if (linkLabelContainsLink(markdown, startOffset + 1, labelEnd, labelEnds)) {
      cursor = startOffset + 1;
      continue;
    }
    const destination = parseLinkDestination(markdown, labelEnd + 2);
    if (!destination) {
      cursor = labelEnd + 1;
      continue;
    }

    chunks.push(markdown.slice(emittedThrough, image ? startOffset - 1 : startOffset));
    if (!image) {
      chunks.push(markdown.slice(startOffset + 1, labelEnd));
    }
    emittedThrough = destination.closingParen + 1;
    cursor = emittedThrough;
  }

  chunks.push(markdown.slice(emittedThrough));
  return chunks.join("");
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

type SourceLocator = (bodyOffset: number) => SourceLocationIR;

function createSourceLocator(
  bodyRaw: string,
  bodyStartOffset: number,
  bodyStartLine: number
): SourceLocator {
  const lineStarts = [0];
  for (let cursor = 0; cursor < bodyRaw.length; cursor += 1) {
    if (bodyRaw[cursor] === "\r" && bodyRaw[cursor + 1] === "\n") {
      cursor += 1;
      lineStarts.push(cursor + 1);
    } else if (bodyRaw[cursor] === "\r" || bodyRaw[cursor] === "\n") {
      lineStarts.push(cursor + 1);
    }
  }

  return (bodyOffset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle]! <= bodyOffset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return {
      line: bodyStartLine + low,
      column: bodyOffset - lineStarts[low]! + 1,
      offset: bodyStartOffset + bodyOffset
    };
  };
}
