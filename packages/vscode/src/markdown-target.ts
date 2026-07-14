import { classifyLinkTarget, resolveMarkdownTarget } from "@okfx/core";

export function resolveDefinitionTarget(sourcePath: string, targetRaw: string): string | undefined {
  return classifyLinkTarget(targetRaw) === "internal"
    ? resolveMarkdownTarget(sourcePath, targetRaw)
    : undefined;
}

export function markdownTargetAtDocument(
  markdown: string,
  lineNumber: number,
  character: number
): string | undefined {
  const lines = markdown.split(/\r\n|\n|\r/);
  if (lineNumber < 0 || lineNumber >= lines.length || lineIsFencedCode(lines, lineNumber)) {
    return undefined;
  }
  return markdownTargetAt(lines[lineNumber]!, character);
}

export function markdownTargetAt(line: string, character: number): string | undefined {
  const cursor = Math.max(0, Math.min(character, line.length));
  const searchableLine = maskInlineCode(line);
  let searchFrom = cursor - 1;
  while (searchFrom >= 0) {
    const linkStart = searchableLine.lastIndexOf("](", searchFrom);
    if (linkStart === -1) {
      return undefined;
    }
    searchFrom = linkStart - 1;
    const labelStart = findLinkLabelStart(searchableLine, linkStart);
    if (labelStart === undefined
      || (searchableLine[labelStart - 1] === "!" && !isEscaped(searchableLine, labelStart - 1))
      || linkLabelContainsLink(searchableLine, labelStart + 1, linkStart)) {
      continue;
    }

    const targetStart = linkStart + 2;
    const destination = parseDestination(searchableLine, targetStart);
    if (!destination || cursor < targetStart || cursor > destination.closingParen) {
      continue;
    }
    return line.slice(destination.targetStart, destination.targetEnd);
  }

  return undefined;
}

function maskInlineCode(line: string): string {
  const chunks: string[] = [];
  let emittedThrough = 0;
  let cursor = 0;

  while (cursor < line.length) {
    const opener = line.indexOf("`", cursor);
    if (opener === -1) {
      break;
    }
    if (isEscaped(line, opener)) {
      cursor = opener + 1;
      continue;
    }

    const delimiterLength = backtickRunLength(line, opener);
    let searchFrom = opener + delimiterLength;
    let closingEnd: number | undefined;
    while (searchFrom < line.length) {
      const candidate = line.indexOf("`", searchFrom);
      if (candidate === -1) {
        break;
      }
      const candidateLength = backtickRunLength(line, candidate);
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
    chunks.push(line.slice(emittedThrough, opener));
    chunks.push(" ".repeat(closingEnd - opener));
    emittedThrough = closingEnd;
    cursor = closingEnd;
  }

  chunks.push(line.slice(emittedThrough));
  return chunks.join("");
}

function backtickRunLength(value: string, start: number): number {
  let end = start;
  while (value[end] === "`") {
    end += 1;
  }
  return end - start;
}

function lineIsFencedCode(lines: string[], lineNumber: number): boolean {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (let index = 0; index <= lineNumber; index += 1) {
    const line = lines[index] ?? "";
    if (fence) {
      if (isClosingFence(line, fence)) {
        fence = undefined;
      }
      if (index === lineNumber) {
        return true;
      }
      continue;
    }

    const openingFence = parseOpeningFence(line);
    if (openingFence) {
      fence = openingFence;
      if (index === lineNumber) {
        return true;
      }
    }
  }
  return false;
}

function parseOpeningFence(line: string): { marker: "`" | "~"; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1]!.startsWith("`") && match[2]!.includes("`"))) {
    return undefined;
  }
  return {
    marker: match[1]![0] as "`" | "~",
    length: match[1]!.length
  };
}

function isClosingFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[1]![0] === fence.marker && match[1]!.length >= fence.length);
}

function findLinkLabelStart(line: string, closingBracket: number): number | undefined {
  let nestedBrackets = 0;
  for (let cursor = closingBracket - 1; cursor >= 0; cursor -= 1) {
    if (isEscaped(line, cursor)) {
      continue;
    }
    if (line[cursor] === "]") {
      nestedBrackets += 1;
    } else if (line[cursor] === "[") {
      if (nestedBrackets === 0) {
        return cursor;
      }
      nestedBrackets -= 1;
    }
  }
  return undefined;
}

function linkLabelContainsLink(line: string, start: number, end: number): boolean {
  let cursor = start;
  while (cursor < end) {
    const nestedStart = line.indexOf("[", cursor);
    if (nestedStart === -1 || nestedStart >= end) {
      return false;
    }
    if (isEscaped(line, nestedStart)
      || (line[nestedStart - 1] === "!" && !isEscaped(line, nestedStart - 1))) {
      cursor = nestedStart + 1;
      continue;
    }

    const nestedEnd = findLinkLabelEnd(line, nestedStart + 1, end);
    if (nestedEnd !== undefined && line[nestedEnd + 1] === "(") {
      const destination = parseDestination(line, nestedEnd + 2);
      if (destination && destination.closingParen < end) {
        return true;
      }
    }
    cursor = nestedStart + 1;
  }

  return false;
}

function findLinkLabelEnd(line: string, start: number, end: number): number | undefined {
  let depth = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    if (isEscaped(line, cursor)) {
      continue;
    }
    if (line[cursor] === "[") {
      depth += 1;
    } else if (line[cursor] === "]") {
      if (depth === 0) {
        return cursor;
      }
      depth -= 1;
    }
  }
  return undefined;
}

function parseDestination(
  line: string,
  targetStart: number
): { targetStart: number; targetEnd: number; closingParen: number } | undefined {
  let destinationStart = targetStart;
  while (destinationStart < line.length && /[ \t]/u.test(line[destinationStart] ?? "")) {
    destinationStart += 1;
  }

  if (destinationStart > targetStart
    && (line[destinationStart] === ")"
      || line[destinationStart] === "\""
      || line[destinationStart] === "'"
      || line[destinationStart] === "(")) {
    return parseDestinationTail(line, targetStart, destinationStart, destinationStart);
  }

  if (line[destinationStart] === "<") {
    let cursor = destinationStart + 1;
    while (cursor < line.length) {
      const character = line[cursor];
      if (character === "<" && !isEscaped(line, cursor)) {
        return undefined;
      }
      if (character === ">" && !isEscaped(line, cursor)) {
        return parseDestinationTail(line, cursor + 1, destinationStart + 1, cursor);
      }
      cursor += 1;
    }
    return undefined;
  }

  let depth = 0;
  let cursor = destinationStart;

  while (cursor < line.length) {
    const character = line[cursor];
    if (character === "(" && !isEscaped(line, cursor)) {
      depth += 1;
    } else if (character === ")" && !isEscaped(line, cursor)) {
      if (depth === 0) {
        return { targetStart: destinationStart, targetEnd: cursor, closingParen: cursor };
      }
      depth -= 1;
    } else if (/\s/u.test(character ?? "")) {
      if (depth !== 0) {
        return undefined;
      }
      return parseDestinationTail(line, cursor, destinationStart, cursor);
    }
    cursor += 1;
  }

  return undefined;
}

function parseDestinationTail(
  line: string,
  tailStart: number,
  targetStart: number,
  targetEnd: number
): { targetStart: number; targetEnd: number; closingParen: number } | undefined {
  let cursor = tailStart;
  while (cursor < line.length && /[ \t]/u.test(line[cursor] ?? "")) {
    cursor += 1;
  }
  const hasTitleSeparator = cursor > tailStart;
  if (line[cursor] === ")") {
    return { targetStart, targetEnd, closingParen: cursor };
  }
  if (!hasTitleSeparator) {
    return undefined;
  }

  const quote = line[cursor];
  if (quote !== "\"" && quote !== "'" && quote !== "(") {
    return undefined;
  }
  const closingQuote = quote === "(" ? ")" : quote;

  cursor += 1;
  while (cursor < line.length) {
    if (line[cursor] === closingQuote && !isEscaped(line, cursor)) {
      let closingParen = cursor + 1;
      while (closingParen < line.length && /[ \t]/u.test(line[closingParen] ?? "")) {
        closingParen += 1;
      }
      return line[closingParen] === ")"
        ? { targetStart, targetEnd, closingParen }
        : undefined;
    }
    cursor += 1;
  }
  return undefined;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
