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
  return line.slice(targetStart, destination.targetEnd);
}

function parseDestination(
  line: string,
  targetStart: number
): { targetEnd: number; closingParen: number } | undefined {
  let depth = 0;
  let cursor = targetStart;

  while (cursor < line.length) {
    const character = line[cursor];
    if (character === "(" && !isEscaped(line, cursor)) {
      depth += 1;
    } else if (character === ")" && !isEscaped(line, cursor)) {
      if (depth === 0) {
        return cursor === targetStart ? undefined : { targetEnd: cursor, closingParen: cursor };
      }
      depth -= 1;
    } else if (/\s/u.test(character ?? "")) {
      if (depth !== 0 || cursor === targetStart) {
        return undefined;
      }
      return parseTitle(line, cursor);
    }
    cursor += 1;
  }

  return undefined;
}

function parseTitle(
  line: string,
  targetEnd: number
): { targetEnd: number; closingParen: number } | undefined {
  let cursor = targetEnd;
  while (cursor < line.length && /[ \t]/u.test(line[cursor] ?? "")) {
    cursor += 1;
  }
  const quote = line[cursor];
  if (quote !== "\"" && quote !== "'") {
    return undefined;
  }

  cursor += 1;
  while (cursor < line.length) {
    if (line[cursor] === quote && !isEscaped(line, cursor)) {
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
