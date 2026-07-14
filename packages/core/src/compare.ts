export function compareStrings(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex)!;
    const rightCodePoint = right.codePointAt(rightIndex)!;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }

  return leftIndex < left.length ? 1 : (rightIndex < right.length ? -1 : 0);
}

export function buildStringRanks(values: readonly string[]): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    if (!ranks.has(value)) {
      ranks.set(value, index);
    }
  }
  return ranks;
}
