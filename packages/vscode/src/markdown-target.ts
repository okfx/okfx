export function markdownTargetAt(line: string, character: number): string | undefined {
  const cursor = Math.max(0, Math.min(character, line.length));
  const linkStart = line.slice(0, cursor).lastIndexOf("](");
  if (linkStart === -1) {
    return undefined;
  }

  const targetStart = linkStart + 2;
  const destination = parseDestination(line, targetStart);
  if (!destination || cursor < targetStart || cursor > destination.closingParen) {
    return undefined;
  }
  const enclosed = line[targetStart] === "<";
  return line.slice(enclosed ? targetStart + 1 : targetStart, destination.targetEnd);
}

function parseDestination(
  line: string,
  targetStart: number
): { targetEnd: number; closingParen: number } | undefined {
  if (line[targetStart] === "<") {
    let cursor = targetStart + 1;
    while (cursor < line.length) {
      const character = line[cursor];
      if (character === "<" && !isEscaped(line, cursor)) {
        return undefined;
      }
      if (character === ">" && !isEscaped(line, cursor)) {
        return parseDestinationTail(line, cursor + 1, cursor);
      }
      cursor += 1;
    }
    return undefined;
  }

  let depth = 0;
  let cursor = targetStart;

  while (cursor < line.length) {
    const character = line[cursor];
    if (character === "(" && !isEscaped(line, cursor)) {
      depth += 1;
    } else if (character === ")" && !isEscaped(line, cursor)) {
      if (depth === 0) {
        return { targetEnd: cursor, closingParen: cursor };
      }
      depth -= 1;
    } else if (/\s/u.test(character ?? "")) {
      if (depth !== 0) {
        return undefined;
      }
      return parseDestinationTail(line, cursor, cursor);
    }
    cursor += 1;
  }

  return undefined;
}

function parseDestinationTail(
  line: string,
  tailStart: number,
  targetEnd: number
): { targetEnd: number; closingParen: number } | undefined {
  let cursor = tailStart;
  while (cursor < line.length && /[ \t]/u.test(line[cursor] ?? "")) {
    cursor += 1;
  }
  const hasTitleSeparator = cursor > tailStart;
  if (line[cursor] === ")") {
    return { targetEnd, closingParen: cursor };
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
      return line[cursor + 1] === ")"
        ? { targetEnd, closingParen: cursor + 1 }
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
